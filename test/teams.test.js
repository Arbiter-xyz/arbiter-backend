import test from 'node:test';
import assert from 'node:assert/strict';
import { Keypair } from '@stellar/stellar-sdk';
import {
  TeamError,
  createTeam,
  addMembers,
  setMemberRole,
  removeMember,
  getTeam,
  roleOf,
} from '../src/teams.js';
import {
  parseNumericAnswer,
  numericToleranceVote,
} from '../src/consensus.js';

test('setMemberRole serializes concurrent ownership transfers so a team never ends up with two owners (#275)', async () => {
  const owner = Keypair.random().publicKey();
  const memberA = Keypair.random().publicKey();
  const memberB = Keypair.random().publicKey();

  const team = await createTeam(owner, 'Arbiter Core');
  await addMembers(team.id, owner, [memberA, memberB], 'member');

  // Fire two concurrent ownership transfers from the current owner to two different members.
  const results = await Promise.allSettled([
    setMemberRole(team.id, owner, memberA, 'owner'),
    setMemberRole(team.id, owner, memberB, 'owner'),
  ]);

  const fulfilled = results.filter((r) => r.status === 'fulfilled');
  const rejected = results.filter((r) => r.status === 'rejected');
  assert.equal(fulfilled.length, 1, 'exactly one concurrent ownership transfer must succeed');
  assert.equal(rejected.length, 1, 'the second concurrent transfer must fail since actor is no longer owner');
  assert.ok(rejected[0].reason instanceof TeamError);
  assert.equal(rejected[0].reason.status, 403);

  const persisted = await getTeam(team.id);
  const owners = persisted.members.filter((m) => m.role === 'owner');
  assert.equal(owners.length, 1, 'team must always have exactly one owner');
  assert.equal(owners[0].address, memberA);
  assert.equal(roleOf(persisted, owner), 'admin');
  assert.equal(roleOf(persisted, memberB), 'member');
});

test('removeMember enforces role hierarchy and blocks removing the owner', async () => {
  const owner = Keypair.random().publicKey();
  const admin = Keypair.random().publicKey();
  const member = Keypair.random().publicKey();

  const team = await createTeam(owner, 'Ops Team');
  await addMembers(team.id, owner, [admin], 'admin');
  await addMembers(team.id, admin, [member], 'member');

  await assert.rejects(() => removeMember(team.id, owner, owner), { status: 409 });
  await assert.rejects(() => removeMember(team.id, member, admin), { status: 403 });

  const afterRemove = await removeMember(team.id, admin, member);
  assert.equal(roleOf(afterRemove, member), null);
});

test('parseNumericAnswer and numericToleranceVote support unambiguous European thousands+decimal format (#274)', () => {
  assert.equal(parseNumericAnswer('1.234,56'), 1234.56);
  assert.equal(parseNumericAnswer('€1.234,50'), 1234.5);
  assert.equal(parseNumericAnswer('-1.234.567,89'), -1234567.89);
  assert.equal(parseNumericAnswer('about 12.345,00%'), 12345);

  // Bare decimal comma without thousands period remains rejected as ambiguous
  assert.equal(parseNumericAnswer('3,5'), null);
  assert.equal(parseNumericAnswer('1,234'), 1234);

  const vote = numericToleranceVote(
    [
      { workerId: 'us', answer: '$1,234.50', established: true },
      { workerId: 'eu', answer: '€1.234,50', established: true },
      { workerId: 'plain', answer: '1234.5', established: true },
    ],
    { absolute: 0.01 },
    () => new Map(),
  );
  assert.equal(vote.allAgree, true);
  assert.deepEqual(vote.matchingWorkerIds, ['us', 'eu', 'plain']);
});
