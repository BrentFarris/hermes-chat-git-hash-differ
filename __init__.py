"""Hermes plugin entry point; no model tools or prompt changes."""

from .backend import DifferService


def register(ctx):
    service = DifferService(ctx)
    for name, handler in service.methods.items():
        ctx.register_rpc(name, handler)
    for event in ("pre_llm_call", "post_tool_call", "post_llm_call", "post_compaction", "on_session_delete"):
        ctx.register_hook(event, service.changed)
    ctx.on_unload(service.close)
