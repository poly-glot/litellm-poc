"""Unit tests for TagValidationHook — mandatory tags on completions, prefix validation, null-safe metadata."""

import pytest
from fastapi import HTTPException

from custom_hooks import TagValidationHook


async def run_hook(data, call_type="acompletion"):
    return await TagValidationHook.async_pre_call_hook(None, None, data, call_type)


async def test_valid_tags_pass():
    data = {"metadata": {"tags": ["agent:main-app", "mcp:acme_mcp", "tenant:tenant-a"]}}
    assert await run_hook(data) is None


@pytest.mark.parametrize(
    "tags",
    [["poc"], ["agent:"], ["agent:main-app", "poc"], ["Agent:main-app"]],
    ids=["unprefixed", "empty-suffix", "valid-plus-invalid", "uppercase-prefix"],
)
async def test_invalid_prefix_rejected_400(tags):
    with pytest.raises(HTTPException) as exc_info:
        await run_hook({"metadata": {"tags": tags}})
    assert exc_info.value.status_code == 400


@pytest.mark.parametrize(
    "data",
    [{}, {"metadata": None}, {"metadata": {}}, {"metadata": {"tags": []}}, {"metadata": {"tags": None}}],
    ids=["metadata-absent", "metadata-null", "tags-absent", "tags-empty", "tags-null"],
)
async def test_untagged_completion_rejected_400(data):
    with pytest.raises(HTTPException) as exc_info:
        await run_hook(data)
    assert exc_info.value.status_code == 400


@pytest.mark.parametrize(
    "call_type",
    ["acompletion", "atext_completion", "completion", "text_completion"],
)
async def test_every_completion_call_type_requires_tags(call_type):
    with pytest.raises(HTTPException) as exc_info:
        await run_hook({"metadata": {"tags": []}}, call_type)
    assert exc_info.value.status_code == 400


async def test_untagged_non_completion_passes_through():
    assert await run_hook({"metadata": None}, "aembedding") is None


async def test_invalid_prefix_on_non_completion_still_rejected_400():
    with pytest.raises(HTTPException) as exc_info:
        await run_hook({"metadata": {"tags": ["poc"]}}, "aembedding")
    assert exc_info.value.status_code == 400
