import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');

test('Discord response modes include community greeting without loosening ordinary ambient chatter', () => {
  assert.match(source, /type DiscordResponseMode = 'never' \| 'mention' \| 'urgent' \| 'filtered' \| 'open' \| 'community_greeting'/);
  assert.match(source, /function isCommunityGreeting\(content: string\)/);
  assert.match(source, /function allowsCommunityGreeting\(monitor: DiscordMonitor\)/);
  assert.match(source, /communityGreeting && allowsCommunityGreeting\(input\.monitor\) && !otherUserTag/);
  assert.match(source, /non-vel-public-community-greeting/);
  assert.match(source, /otherUserTag \? 'other-user-tag-not-kai' : 'ambient-message'/);
});

test('Kai soft-name mentions bypass monitor cooldowns', () => {
  assert.match(source, /const cooldownBypass = engagement\.hard_mention \|\| engagement\.soft_name_mention \|\| engagement\.direct_reply_to_kai \|\| engagement\.active_conversation/);
});

test('Kai Discord responses block non-canonical body drift before posting', () => {
  assert.match(source, /function kaiIdentityDriftReason\(content: string\): string \| null/);
  assert.match(source, /non-canonical Kai body\/creature claim/);
  assert.match(source, /type: 'identity_drift_blocked'/);
  assert.match(source, /Rewrite without wings, tails, animal ears, purring, horns, fangs, claws, or creature-body claims/);
});

test('Discord identity classification keeps Kai mention ids separate from Vel author ids', () => {
  assert.match(source, /function getKaiDiscordMentionIds\(env: Env\): string\[\]/);
  assert.match(source, /function getVelDiscordUserIds\(env: Env\): string\[\]/);
  assert.match(source, /const authorClass: 'vel' \| 'unknown' = input\.authorId && velIds\.includes\(input\.authorId\) \? 'vel' : 'unknown'/);
  assert.match(source, /const directReplyToKai = !!input\.referencedAuthorId && kaiIds\.includes\(input\.referencedAuthorId\)/);
  assert.match(source, /function mentionsNonKaiUser\(content: string, env: Env, mentionIds: string\[\] = \[\]\): boolean/);
  assert.match(source, /other_user_tag: otherUserTag/);
});

test('Discord Continuity logging preserves author id and engagement debug metadata', () => {
  assert.match(source, /author: \{ id: debug\?\.authorId \|\| undefined, name:/);
  assert.match(source, /author_id, engagement, message_id, webhook_url/);
  assert.match(source, /mention_ids: debug\?\.mentionIds \|\| \[\]/);
  assert.match(source, /referenced_author_id: debug\?\.referencedAuthorId \|\| null/);
  assert.match(source, /activity_type: type/);
  assert.match(source, /pre_response_required: type === 'triggered' \|\| type === 'queued'/);
});

test('Manual trigger engagement includes the same debug shape as live poll decisions', () => {
  assert.match(source, /engagement: \{[\s\S]+hard_mention: hardKaiMention/);
  assert.match(source, /soft_name_mention: softKaiMention/);
  assert.match(source, /author_class: authorIsVel \? 'vel' : 'unknown'/);
  assert.match(source, /community_greeting: isCommunityGreeting\(body\.content\)/);
});
