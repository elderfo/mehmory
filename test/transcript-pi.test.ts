import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { readPiSession, stripPiSkillEnvelope } from '../src/transcript/pi.js';
import { atomicWrite } from '../src/core/fs.js';
import { statePath } from '../src/core/home.js';

const SESSION = 'dd000000-0000-4000-8000-000000000000';

const header = JSON.stringify({
  type: 'session',
  version: 3,
  id: SESSION,
  timestamp: '2026-09-01T10:00:00.000Z',
  cwd: '/home/u/proj',
});

function message(id: string, timestamp: string, role: string, content: unknown): string {
  return JSON.stringify({ type: 'message', id, parentId: null, timestamp, message: { role, content } });
}

function write(name: string, lines: readonly string[]): string {
  const path = join(statePath('test-fixtures'), name);
  atomicWrite(path, `${lines.join('\n')}\n`);
  return path;
}

describe('stripPiSkillEnvelope', () => {
  it('keeps only the arguments typed after a /skill: expansion', () => {
    expect(
      stripPiSkillEnvelope(
        '<skill name="remember" location="/x/skills/remember/SKILL.md">\nbody line\n\nmore body\n</skill>\n\n  staging is read-only  '
      )
    ).toBe('staging is read-only');
  });

  it('returns empty for an envelope with no arguments', () => {
    expect(
      stripPiSkillEnvelope('<skill name="integrate" location="/x/SKILL.md">\nbody\n</skill>')
    ).toBe('');
  });

  it('leaves ordinary text, including text that merely mentions a skill tag, unchanged', () => {
    expect(stripPiSkillEnvelope('ship it')).toBe('ship it');
    expect(stripPiSkillEnvelope('what does <skill name="x"> do?')).toBe('what does <skill name="x"> do?');
  });
});

describe('pi session reader', () => {
  it('normalizes user and assistant messages into the distiller record shape', () => {
    const path = write('pi-normalize.jsonl', [
      header,
      JSON.stringify({ type: 'model_change', id: 'b0', timestamp: '2026-09-01T10:00:00.050Z' }),
      message('b1', '2026-09-01T10:00:00.100Z', 'system', 'system prompt'),
      JSON.stringify({
        type: 'custom_message',
        id: 'b2',
        timestamp: '2026-09-01T10:00:00.200Z',
        customType: 'mehmory',
        content: 'we decided to remember',
        display: false,
      }),
      message('b3', '2026-09-01T10:00:01.000Z', 'user', [{ type: 'text', text: 'ship it' }]),
      message('b4', '2026-09-01T10:00:02.000Z', 'assistant', [
        { type: 'thinking', thinking: 'hmm' },
        { type: 'text', text: 'on it' },
        { type: 'toolCall', id: 'c1', name: 'bash', arguments: {} },
        { type: 'text', text: 'done' },
      ]),
      message('b5', '2026-09-01T10:00:03.000Z', 'toolResult', [{ type: 'text', text: 'ok' }]),
      message('b6', '2026-09-01T10:00:04.000Z', 'user', 'plain string content'),
    ]);

    expect(readPiSession(path)).toEqual({
      skipped: 0,
      endOffset: expect.any(Number) as number,
      records: [
        {
          type: 'message',
          role: 'user',
          text: 'ship it',
          timestamp: '2026-09-01T10:00:01.000Z',
          uuid: 'b3',
          sessionId: SESSION,
        },
        {
          type: 'message',
          role: 'assistant',
          text: 'on it\ndone',
          timestamp: '2026-09-01T10:00:02.000Z',
          uuid: 'b4',
          sessionId: SESSION,
        },
        {
          type: 'message',
          role: 'user',
          text: 'plain string content',
          timestamp: '2026-09-01T10:00:04.000Z',
          uuid: 'b6',
          sessionId: SESSION,
        },
      ],
    });
  });

  it('unwraps a skill invocation and drops one with nothing typed after it', () => {
    const path = write('pi-skill.jsonl', [
      header,
      message('c1', '2026-09-01T10:00:01.000Z', 'user', [
        {
          type: 'text',
          text: '<skill name="remember" location="/x/SKILL.md">\nWe decided the body is not user text.\n</skill>\n\nnode 22 is pinned',
        },
      ]),
      message('c2', '2026-09-01T10:00:02.000Z', 'user', [
        { type: 'text', text: '<skill name="integrate" location="/x/SKILL.md">\nbody\n</skill>' },
      ]),
    ]);

    expect(readPiSession(path).records.map(record => record['text'])).toEqual(['node 22 is pinned']);
  });

  it('mints a content-derived uuid when an entry has no id', () => {
    const path = write('pi-no-id.jsonl', [
      header,
      JSON.stringify({
        type: 'message',
        timestamp: '2026-09-01T10:00:02.000Z',
        message: { role: 'user', content: 'no id here' },
      }),
    ]);

    expect(readPiSession(path).records[0]?.uuid).toBe('04a6ad3fdb0ca84333558efe109d3506');
  });

  it('counts only malformed lines as skipped, and leaves a torn tail for the next pass', () => {
    const good = message('d1', '2026-09-01T10:00:01.000Z', 'user', 'first');
    const path = join(statePath('test-fixtures'), 'pi-torn.jsonl');
    atomicWrite(path, `${header}\n${good}\n{"type":"message","id":"d2"\n{"type":"message"`);

    const { records, skipped, endOffset } = readPiSession(path);
    expect(records.map(record => record['text'])).toEqual(['first']);
    expect(skipped).toBe(1);
    expect(endOffset).toBe(Buffer.byteLength(`${header}\n${good}\n{"type":"message","id":"d2"\n`, 'utf-8'));
  });

  it('resumes from a byte offset without the header and without inventing a session id', () => {
    const one = message('e1', '2026-09-01T10:00:01.000Z', 'user', 'one');
    const two = message('e2', '2026-09-01T10:00:02.000Z', 'user', 'two');
    const path = write('pi-resume.jsonl', [header, one, two]);

    const tail = readPiSession(path, Buffer.byteLength(`${header}\n${one}\n`, 'utf-8'));
    expect(tail.records).toEqual([
      { type: 'message', role: 'user', text: 'two', timestamp: '2026-09-01T10:00:02.000Z', uuid: 'e2' },
    ]);
  });
});
