'use strict';

/**
 * tests/unit.js
 *
 * Unit tests for non-LLM deterministic utility modules.
 * No test framework required — plain assertions only.
 *
 * Usage: node tests/unit.js
 * Exit code: 0 if all pass, 1 if any fail.
 */

const path = require('path');

// Resolve src/ relative to this file
const SRC = path.resolve(__dirname, '..', 'src');
const { countTokens } = require(path.join(SRC, 'tokenCounter'));
const { scoreKeywordOverlap } = require(path.join(SRC, 'keywordScorer'));
const { runTokenBudgetGate } = require(path.join(SRC, 'tokenBudgetGate'));

// ─────────────────────────────────────────────────────────────────────────────
// Test 1 — Token counter
// ─────────────────────────────────────────────────────────────────────────────

function testTokenCounter() {
  // "hello world" = 2 words → Math.ceil(2 * 1.33) = Math.ceil(2.66) = 3
  const t1 = countTokens('hello world');
  if (t1 !== 3) throw new Error(`Expected 3, got ${t1}`);

  // Empty string → 0
  const t2 = countTokens('');
  if (t2 !== 0) throw new Error(`Expected 0 for empty string, got ${t2}`);

  // "one" = 1 word → Math.ceil(1 * 1.33) = Math.ceil(1.33) = 2
  const t3 = countTokens('one');
  if (t3 !== 2) throw new Error(`Expected 2, got ${t3}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Test 2 — Keyword scorer
// ─────────────────────────────────────────────────────────────────────────────

function testKeywordScorer() {
  // Identical non-trivial strings should score 1.0
  const identical = scoreKeywordOverlap('enterprise AI adoption', 'enterprise AI adoption');
  if (identical !== 1.0) throw new Error(`Identical strings should score 1.0, got ${identical}`);

  // Completely disjoint strings should score 0.0
  const disjoint = scoreKeywordOverlap('apple orange banana', 'xyz qrs tuv');
  if (disjoint !== 0.0) throw new Error(`Disjoint strings should score 0.0, got ${disjoint}`);

  // Partial overlap should score strictly between 0 and 1
  const partial = scoreKeywordOverlap('enterprise AI strategy', 'enterprise cloud strategy');
  if (partial <= 0 || partial >= 1) throw new Error(`Partial overlap should be (0,1), got ${partial}`);

  // Empty query should return 0, not throw
  const empty = scoreKeywordOverlap('', 'some text here');
  if (empty !== 0) throw new Error(`Empty query should return 0, got ${empty}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Test 3 — Deduplication helper (via tokenBudgetGate internal behaviour)
// ─────────────────────────────────────────────────────────────────────────────
// We test deduplication indirectly: give the gate two web snippets with the
// same URL and confirm only one appears in kept+dropped.

function testDeduplication() {
  const sameUrl = 'https://example.com/article';
  const webSnippets = [
    { url: sameUrl, title: 'Article', content: 'enterprise AI cloud adoption strategy 2025' },
    { url: sameUrl, title: 'Article copy', content: 'enterprise AI cloud adoption strategy 2025 duplicate' }
  ];

  const result = runTokenBudgetGate(webSnippets, [], [], 'enterprise AI adoption');
  const total = result.kept.length + result.dropped.length;
  // After dedup, two items with the same URL → only 1 survives
  if (total !== 1) throw new Error(`Dedup should reduce 2 same-URL snippets to 1, got ${total}`);

  // Unique labels — all should survive (before budget check)
  const uniqueSnippets = [
    { url: 'https://a.com', title: 'A', content: 'alpha bravo charlie' },
    { url: 'https://b.com', title: 'B', content: 'delta echo foxtrot' }
  ];
  const result2 = runTokenBudgetGate(uniqueSnippets, [], [], 'alpha bravo');
  const total2 = result2.kept.length + result2.dropped.length;
  if (total2 !== 2) throw new Error(`Unique labels: expected 2 items, got ${total2}`);

  // Empty array — returns empty kept and dropped
  const result3 = runTokenBudgetGate([], [], [], 'test query');
  if (result3.kept.length !== 0 || result3.dropped.length !== 0) {
    throw new Error(`Empty input should give empty kept/dropped, got kept=${result3.kept.length} dropped=${result3.dropped.length}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Test 4 — Budget gate keep/drop logic
// ─────────────────────────────────────────────────────────────────────────────

function testBudgetGate() {
  // Build snippets whose combined tokens are under 1,600 → all kept, none dropped
  // 5 snippets × ~10 words each → ~10 * 1.33 = ~14 tokens each → ~70 tokens total (well under 1,600)
  const smallSnippets = Array.from({ length: 5 }, (_, i) => ({
    url: `https://example${i}.com`,
    title: `Source ${i}`,
    content: 'enterprise research strategy business market analysis'
  }));
  const resultSmall = runTokenBudgetGate(smallSnippets, [], [], 'enterprise research');
  if (resultSmall.dropped.length !== 0) {
    throw new Error(`Under-budget items should all be kept, got ${resultSmall.dropped.length} dropped`);
  }
  if (resultSmall.kept_tokens > 1600) {
    throw new Error(`kept_tokens=${resultSmall.kept_tokens} should be ≤ 1600`);
  }

  // Build snippets that collectively exceed 1,600 tokens so some get dropped.
  // Each snippet: ~300 words → ~399 tokens. 5 snippets = ~1995 tokens > 1600.
  const bigWords = Array.from({ length: 300 }, (_, i) => `word${i}`).join(' ');
  const bigSnippets = Array.from({ length: 5 }, (_, i) => ({
    url: `https://big${i}.com`,
    title: `Big ${i}`,
    content: bigWords
  }));
  const resultBig = runTokenBudgetGate(bigSnippets, [], [], 'word0 word1 word2');
  if (resultBig.dropped.length === 0) {
    throw new Error('Over-budget items should produce non-empty dropped list');
  }
  if (resultBig.kept_tokens > 1600) {
    throw new Error(`kept_tokens=${resultBig.kept_tokens} exceeds 1600 — hard limit violated`);
  }

  // Tiebreak: memory > docs > web when scores are equal.
  // Give one item of each type with zero-match text so all score 0 → tiebreak applies.
  const webItem = { url: 'https://w.com', title: 'W', content: 'zzz' };
  const docChunk = { source_filename: 'doc.txt', chunk_index: 0, word_count: 1, text: 'zzz' };
  const memEntry = { query: 'zzz', sub_questions: [], summaries: [], sources_used: [], timestamp: '2025-01-01T00:00:00.000Z' };
  const resultTie = runTokenBudgetGate([webItem], [docChunk], [memEntry], 'unrelated xyz');
  // All three score 0; tiebreak: memory > doc > web → memory should be first kept
  if (resultTie.kept.length > 0 && resultTie.kept[0].type !== 'memory') {
    throw new Error(`Tiebreak failed: expected memory first, got ${resultTie.kept[0].type}`);
  }

  // Empty input
  const resultEmpty = runTokenBudgetGate([], [], [], 'test');
  if (resultEmpty.kept.length !== 0 || resultEmpty.dropped.length !== 0) {
    throw new Error('Empty input should return empty kept and dropped');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Test 5 — Memory quality gate (logic extracted inline to mirror pipeline.js)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Mirror of the quality gate logic in pipeline.js so we can test it without
 * running the full pipeline. Returns true if the sub-question result passes.
 */
function qualityGatePasses({ overallSuccess, keptItems, answer, summaryObj }) {
  if (!overallSuccess) return false;
  const hasFreshSource = keptItems.some(item => item.type === 'web' || item.type === 'doc');
  if (!hasFreshSource) return false;
  if (answer.trimStart().startsWith('[Error')) return false;
  const wordCount = answer.trim().split(/\s+/).filter(Boolean).length;
  if (wordCount < 50) return false;
  const sourcesCited = summaryObj && Array.isArray(summaryObj.sources_cited) ? summaryObj.sources_cited : [];
  if (sourcesCited.length === 0) return false;
  return true;
}

function testMemoryQualityGate() {
  // A successful result with a web source and 60-word answer passes
  const goodAnswer = Array.from({ length: 60 }, (_, i) => `word${i}`).join(' ');
  const passes = qualityGatePasses({
    overallSuccess: true,
    keptItems: [{ type: 'web', source: 'https://example.com' }],
    answer: goodAnswer,
    summaryObj: { summary: 'test', sources_cited: ['https://example.com'], key_facts: [] }
  });
  if (!passes) throw new Error('Good result should pass the quality gate');

  // A failed run (overallSuccess false) does not pass
  const failedRun = qualityGatePasses({
    overallSuccess: false,
    keptItems: [{ type: 'web', source: 'https://example.com' }],
    answer: goodAnswer,
    summaryObj: { summary: 'test', sources_cited: ['https://example.com'], key_facts: [] }
  });
  if (failedRun) throw new Error('Failed run should not pass the quality gate');

  // Only memory sources → does not pass
  const memoryOnly = qualityGatePasses({
    overallSuccess: true,
    keptItems: [{ type: 'memory', source: 'memory:2025-01-01' }],
    answer: goodAnswer,
    summaryObj: { summary: 'test', sources_cited: ['memory:2025-01-01'], key_facts: [] }
  });
  if (memoryOnly) throw new Error('Memory-only sources should not pass the quality gate');

  // Answer under 50 words → does not pass
  const shortAnswer = 'This is a brief answer.';
  const tooShort = qualityGatePasses({
    overallSuccess: true,
    keptItems: [{ type: 'web', source: 'https://example.com' }],
    answer: shortAnswer,
    summaryObj: { summary: 'test', sources_cited: ['https://example.com'], key_facts: [] }
  });
  if (tooShort) throw new Error('Under-50-word answer should not pass the quality gate');
}

// ─────────────────────────────────────────────────────────────────────────────
// Runner
// ─────────────────────────────────────────────────────────────────────────────

const tests = [
  testTokenCounter,
  testKeywordScorer,
  testDeduplication,
  testBudgetGate,
  testMemoryQualityGate
];

let passed = 0;
let failed = 0;

for (const t of tests) {
  try {
    t();
    passed++;
    console.log(`  PASS  ${t.name}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL  ${t.name} — ${e.message}`);
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
