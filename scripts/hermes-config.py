"""Resolve the user's Hermes runtime. Stdout is a private parent-process pipe.

Never run this helper directly in a logging terminal: its JSON includes the
runtime key. llm.mjs captures it in memory and never prints or persists it.
"""
import contextlib
import io
import json
import logging
import os
from pathlib import Path
import sys


def main():
    if os.environ.get("PERK_LLM_CONFIG_PIPE") != "1":
        raise RuntimeError("Use the Node parent-process bridge")
    home = Path(os.environ.get("PERK_HERMES_HOME", str(Path.home() / ".hermes"))).expanduser()
    repo = Path(os.environ.get("PERK_HERMES_REPO", str(home / "hermes-agent"))).expanduser()
    if not (home / "config.yaml").is_file() or not (repo / "hermes_cli").is_dir():
        raise RuntimeError("Hermes configuration unavailable")
    # The parent passes this only to the resolver process, never modifies config.
    os.environ["HERMES_HOME"] = str(home)
    sys.path.insert(0, str(repo))
    logging.disable(logging.CRITICAL)
    # Hermes can print migration/auth diagnostics. Discard both streams while
    # resolving so configuration and credential material cannot reach logs.
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
        from hermes_cli.config import load_config
        from hermes_cli.runtime_provider import resolve_runtime_provider
        from hermes_cli.model_normalize import normalize_model_for_provider
        cfg = load_config()
        model_cfg = cfg.get("model", {})
        configured_model = model_cfg.get("default")
        if not isinstance(configured_model, str) or not configured_model.strip():
            raise RuntimeError("Hermes model unavailable")
        runtime = resolve_runtime_provider(
            requested=model_cfg.get("provider"), target_model=configured_model
        )
        provider = runtime.get("provider", model_cfg.get("provider", "custom"))
        model = normalize_model_for_provider(runtime.get("model") or configured_model, provider)
        result = {
            "model": model,
            "configuredModel": configured_model,
            "provider": provider,
            "baseUrl": runtime.get("base_url"),
            "apiKey": runtime.get("api_key"),
            "apiMode": runtime.get("api_mode", "chat_completions"),
            "reasoningEffort": cfg.get("agent", {}).get("reasoning_effort", "medium"),
            "source": "hermes",
        }
        if not isinstance(result["apiKey"], str) or not result["apiKey"].strip():
            raise RuntimeError("Hermes runtime credential unavailable")
    # Only the Node parent reads this pipe; no config/credential is written.
    sys.stdout.write(json.dumps(result))


if __name__ == "__main__":
    try:
        main()
    except BaseException:
        # Avoid traceback/error repr: native resolver errors can contain config.
        sys.stderr.write("Unable to resolve Hermes runtime configuration.\n")
        sys.exit(1)
