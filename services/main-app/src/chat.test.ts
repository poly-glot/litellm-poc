import { describe, expect, it } from 'vitest';

import { buildChatRequest, extractReply, parseChatInput } from './chat.js';

describe('parseChatInput', () => {
  it('accepts a non-empty prompt and tenant', () => {
    expect(parseChatInput('{"prompt":"hello","tenant":"tenant-a"}')).toEqual({
      prompt: 'hello',
      tenant: 'tenant-a',
    });
  });

  it.each([
    ['a missing prompt', '{"tenant":"tenant-a"}'],
    ['a missing tenant', '{"prompt":"hello"}'],
    ['an empty prompt', '{"prompt":"","tenant":"tenant-a"}'],
    ['an empty tenant', '{"prompt":"hello","tenant":""}'],
    ['a non-string prompt', '{"prompt":1,"tenant":"tenant-a"}'],
    ['a JSON null body', 'null'],
    ['a non-JSON body', 'not json'],
  ])('rejects %s', (_label, body) => {
    expect(parseChatInput(body)).toBeNull();
  });
});

describe('buildChatRequest', () => {
  it('carries the agent and tenant tags plus the configured model', () => {
    expect(buildChatRequest({ prompt: 'hello', tenant: 'tenant-a' }, 'qwen3-local')).toEqual({
      messages: [{ content: 'hello', role: 'user' }],
      metadata: { tags: ['agent:main-app', 'tenant:tenant-a'] },
      model: 'qwen3-local',
    });
  });
});

describe('extractReply', () => {
  it('returns the first choice content', () => {
    expect(extractReply({ choices: [{ message: { content: 'hi' } }], model: 'x' })).toBe('hi');
  });

  it('falls back to an empty string when there are no choices', () => {
    expect(extractReply({ choices: [], model: 'x' })).toBe('');
  });
});
