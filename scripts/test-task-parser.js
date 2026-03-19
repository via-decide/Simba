import assert from 'node:assert/strict';
import { parseTaskMessage } from '../src/task-parser.js';

function testComplexYamlBlockTask() {
  const input = `/task
repo: via-decide/VIA
mode: codex_then_antigravity
task: >
  Refactor the VIA frontend into a subpage-first architecture with no client-side router dependency.

  The goal is to make the whole repo behave like:
  - standalone HTML surfaces
  - shared runtime/utilities
  - direct page links

  Preserve the creator-story.html and creator-onboarding.html patterns.
# User-provided custom instructions

# CODEX AGENT RULES — via-decide/decide.engine-tools
Strictly adhere to the explicit instructions provided by the user.`;

  const parsed = parseTaskMessage(input);

  assert.equal(parsed.targetRepo, 'via-decide/VIA');
  assert.equal(parsed.mode, 'codex_then_antigravity');
  assert.match(parsed.taskDescription, /subpage-first architecture/);
  assert.doesNotMatch(parsed.taskDescription, /^>/);
  assert.match(parsed.constraints, /User-provided custom instructions/i);
  assert.match(parsed.constraints, /Strictly adhere to the explicit instructions/i);
}

function testInlineYamlStillWorks() {
  const parsed = parseTaskMessage('repo: via-decide/decide.engine-tools mode: both task: create idea-remixer tool constraints: preserve existing tools');

  assert.equal(parsed.targetRepo, 'via-decide/decide.engine-tools');
  assert.equal(parsed.mode, 'codex_then_claude');
  assert.equal(parsed.taskDescription, 'create idea-remixer tool');
  assert.equal(parsed.constraints, 'preserve existing tools');
}

function testJsonTaskStillWorks() {
  const parsed = parseTaskMessage('{"repo":"via-decide/decide.engine-tools","mode":"repair","task":"repair artifacts","goal":"stabilize output"}');

  assert.equal(parsed.targetRepo, 'via-decide/decide.engine-tools');
  assert.equal(parsed.mode, 'claude_repair');
  assert.equal(parsed.taskDescription, 'repair artifacts');
  assert.equal(parsed.goal, 'stabilize output');
}

testComplexYamlBlockTask();
testInlineYamlStillWorks();
testJsonTaskStillWorks();

console.log('✅ task-parser regression tests passed');
