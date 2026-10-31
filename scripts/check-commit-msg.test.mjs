import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkMessage } from './check-commit-msg.mjs';

describe('commit message check', () => {
  it('accepts well-formed messages', () => {
    for (const message of [
      'feat(actions): execute approved actions through a queue',
      'fix: keep the time when writing to the database',
      'feat(protocol)!: sign the request method and path\n\nBREAKING CHANGE: the old signature is rejected',
      'fix(api,web): a partial update does not wipe fields',
      'docs: describe the protocol\n\n- signature\n- idempotency',
      'chore(deps): update the IMAP client',
      'refactor(agent): API runner takes a tools executor',
      'Merge branch \'main\' into feat/x',
      'fixup! feat(eval): run repeats',
    ]) {
      assert.deepEqual(checkMessage(message), [], message);
    }
  });

  it('rejects assistant attribution, including in git-generated headers', () => {
    const errors = (message) => checkMessage(message).join('\n');
    assert.match(errors('feat: x\n\nCo-Authored-By: Claude Opus <noreply@anthropic.com>'), /AI-assistant attribution/);
    assert.match(errors('feat: x\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)'), /Generated with/);
    assert.match(errors('Merge branch x\n\nClaude-Session: https://claude.ai/code/123'), /session link/);
    assert.deepEqual(checkMessage('feat: x\n\nCo-Authored-By: Jane Doe <jane@example.com>'), []);
  });

  it('rejects format violations', () => {
    const errors = (message) => checkMessage(message).join('\n');
    assert.match(errors('Added the agent'), /does not follow/);
    assert.match(errors('feature: add the agent'), /does not follow/);
    assert.match(errors('feat(Agent): add the agent'), /does not follow/);
    assert.match(errors('feat: Add the agent'), /lowercase letter/);
    assert.match(errors('feat: add the agent.'), /no period/);
    assert.match(errors(`feat: ${'a very long description '.repeat(5)}`), /longer than 72/);
    assert.match(errors('feat: add the agent\nbody right away'), /blank line/);
  });

  it('ignores git comments and the part after the scissors', () => {
    const message = 'feat: add the agent\n# Please enter the commit message\n# ------------------------ >8 ------------------------\ndiff --git a/x b/x';
    assert.deepEqual(checkMessage(message), []);
    assert.deepEqual(checkMessage('# a comment only'), []);
  });
});
