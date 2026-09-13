import assert from 'node:assert/strict';
import test from 'node:test';
import { disruption, exampleRule, normal } from './data.ts';
import { optimise, replay } from './optimizer.ts';
import { isProhibited, parseRule } from './parser.ts';

test('disruption changes the economic recommendation', () => {
  const initial = optimise(normal);
  const outdated = replay(initial.best, disruption);
  const updated = optimise(disruption, [], initial.best);
  assert.equal(initial.best.strategy.contractor, false);
  assert.equal(updated.best.strategy.contractor, true);
  assert.ok(updated.best.economics.totalCost < outdated.economics.totalCost);
});

test('confirmed manager rule removes prohibited assignments', () => {
  const initial = optimise(normal);
  const updated = optimise(disruption, [], initial.best);
  const rule = parseRule(exampleRule);
  const constrained = optimise(disruption, [rule], updated.best);
  assert.equal(rule.resource, 'H2');
  assert.equal(rule.field, 'north4');
  assert.equal(rule.rainfallMm, 15);
  assert.equal(rule.windowHours, 24);
  assert.equal(constrained.best.assignments.some((assignment) =>
    isProhibited(rule, assignment.resource, assignment.field, assignment.hour, disruption)
  ), false);
});

test('ambiguous or exception-bearing text is rejected', () => {
  assert.throws(() => parseRule('Keep H2 away from North 4.'));
  assert.throws(() => parseRule('Never send H2 to North 4 after 15 mm rain unless urgent within 24 hours.'));
});
