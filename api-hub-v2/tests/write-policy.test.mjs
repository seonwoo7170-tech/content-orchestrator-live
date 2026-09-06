import test from 'node:test';
import assert from 'node:assert/strict';
import { assertBloggerWriteAllowed } from '../src/lib/write-policy.js';

const phase1Env = {
  BLOGGER_WRITES_ENABLED: 'true',
  BLOGGER_WRITE_MODE: 'phase1_single_draft',
  PHASE1_DRAFT_BLOG_ID: '7741529904469657049'
};

const phase2Env = {
  BLOGGER_WRITES_ENABLED: 'true',
  BLOGGER_WRITE_MODE: 'phase2_single_publish',
  PHASE2_SINGLE_PUBLISH_BLOG_ID: 'homefix-blog-id'
};

const phase2RepairEnv = {
  BLOGGER_WRITES_ENABLED: 'true',
  BLOGGER_WRITE_MODE: 'phase2_single_repair',
  PHASE2_SINGLE_REPAIR_BLOG_ID: 'homefix-blog-id',
  PHASE2_SINGLE_REPAIR_POST_ID: 'wrong-language-post-id'
};

test('Blogger writes stay disabled by default', () => {
  assert.throws(() => assertBloggerWriteAllowed({}, {}), /BLOGGER_WRITES_DISABLED/);
});

test('Phase 1 mode permits only the approved target draft create', () => {
  assert.equal(assertBloggerWriteAllowed(phase1Env, {
    phase1Test: true,
    operation: 'create',
    publishMode: 'draft',
    blogId: '7741529904469657049'
  }), true);
});

test('Phase 1 mode blocks publishing, updates, wrong target and missing intent', () => {
  assert.throws(() => assertBloggerWriteAllowed(phase1Env, { phase1Test: true, operation: 'create', publishMode: 'published', blogId: '7741529904469657049' }), /PHASE1_DRAFT_PUBLISH_FORBIDDEN/);
  assert.throws(() => assertBloggerWriteAllowed(phase1Env, { phase1Test: true, operation: 'update', publishMode: 'draft', blogId: '7741529904469657049' }), /PHASE1_DRAFT_CREATE_ONLY/);
  assert.throws(() => assertBloggerWriteAllowed(phase1Env, { phase1Test: true, operation: 'create', publishMode: 'draft', blogId: 'other' }), /PHASE1_DRAFT_TARGET_MISMATCH/);
  assert.throws(() => assertBloggerWriteAllowed(phase1Env, { operation: 'create', publishMode: 'draft', blogId: '7741529904469657049' }), /PHASE1_DRAFT_INTENT_REQUIRED/);
});

test('Phase 2 single publish permits only an intentional exact-target new published post', () => {
  assert.equal(assertBloggerWriteAllowed(phase2Env, {
    phase2SinglePublish: true,
    operation: 'create',
    publishMode: 'published',
    blogId: 'homefix-blog-id'
  }), true);
});

test('Phase 2 single publish blocks draft, update, wrong target, existing post and missing intent', () => {
  assert.throws(() => assertBloggerWriteAllowed(phase2Env, { phase2SinglePublish: true, operation: 'create', publishMode: 'draft', blogId: 'homefix-blog-id' }), /PHASE2_PUBLISH_MODE_REQUIRED/);
  assert.throws(() => assertBloggerWriteAllowed(phase2Env, { phase2SinglePublish: true, operation: 'update', publishMode: 'published', blogId: 'homefix-blog-id' }), /PHASE2_PUBLISH_CREATE_ONLY/);
  assert.throws(() => assertBloggerWriteAllowed(phase2Env, { phase2SinglePublish: true, operation: 'create', publishMode: 'published', blogId: 'other' }), /PHASE2_PUBLISH_TARGET_MISMATCH/);
  assert.throws(() => assertBloggerWriteAllowed(phase2Env, { phase2SinglePublish: true, operation: 'create', publishMode: 'published', blogId: 'homefix-blog-id', bloggerPostId: 'existing' }), /PHASE2_PUBLISH_NEW_POST_ONLY/);
  assert.throws(() => assertBloggerWriteAllowed(phase2Env, { operation: 'create', publishMode: 'published', blogId: 'homefix-blog-id' }), /PHASE2_PUBLISH_INTENT_REQUIRED/);
});

test('Phase 2 single repair permits only the exact existing post update', () => {
  assert.equal(assertBloggerWriteAllowed(phase2RepairEnv, {
    phase2SingleRepair: true,
    operation: 'update',
    blogId: 'homefix-blog-id',
    bloggerPostId: 'wrong-language-post-id'
  }), true);
});

test('Phase 2 single repair blocks create, wrong blog, wrong post and missing intent', () => {
  assert.throws(() => assertBloggerWriteAllowed(phase2RepairEnv, { phase2SingleRepair: true, operation: 'create', blogId: 'homefix-blog-id', bloggerPostId: 'wrong-language-post-id' }), /PHASE2_REPAIR_UPDATE_ONLY/);
  assert.throws(() => assertBloggerWriteAllowed(phase2RepairEnv, { phase2SingleRepair: true, operation: 'update', blogId: 'other', bloggerPostId: 'wrong-language-post-id' }), /PHASE2_REPAIR_TARGET_BLOG_MISMATCH/);
  assert.throws(() => assertBloggerWriteAllowed(phase2RepairEnv, { phase2SingleRepair: true, operation: 'update', blogId: 'homefix-blog-id', bloggerPostId: 'other-post' }), /PHASE2_REPAIR_TARGET_POST_MISMATCH/);
  assert.throws(() => assertBloggerWriteAllowed(phase2RepairEnv, { operation: 'update', blogId: 'homefix-blog-id', bloggerPostId: 'wrong-language-post-id' }), /PHASE2_REPAIR_INTENT_REQUIRED/);
});
