import re

from fastapi import HTTPException
from litellm.integrations.custom_logger import CustomLogger

_COMPLETION_CALL_TYPES = frozenset({'acompletion', 'atext_completion', 'completion', 'text_completion'})
_VALID_TAG = re.compile(r'^(agent|mcp|tenant):.+$')


class _TagValidationHook(CustomLogger):
    async def async_pre_call_hook(self, user_api_key_dict, cache, data: dict, call_type: str):
        metadata = data.get('metadata') or {}
        tags = metadata.get('tags') or []
        if not tags:
            if call_type in _COMPLETION_CALL_TYPES:
                raise HTTPException(
                    status_code=400,
                    detail=(
                        "Missing LiteLLM tags: completion requests must carry metadata.tags "
                        "with entries prefixed 'agent:', 'mcp:', or 'tenant:'."
                    ),
                )
            return

        invalid = [tag for tag in tags if not _VALID_TAG.match(tag)]
        if invalid:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"Invalid LiteLLM tag(s): {invalid}. "
                    "Tags must be prefixed with 'agent:', 'mcp:', or 'tenant:'."
                ),
            )


# LiteLLM's get_instance_fn resolves the name to whatever is bound at module level,
# so the config references this instance directly (not the class above).
TagValidationHook = _TagValidationHook()
