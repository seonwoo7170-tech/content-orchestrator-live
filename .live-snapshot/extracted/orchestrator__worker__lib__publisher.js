// worker/lib/publisher.js
function assertExistingIdentity(original, candidate) {
  const originalBlogId = String(original?.blogId || "");
  const originalPostId = String(original?.bloggerPostId || "");
  const candidateBlogId = String(candidate?.blogId || "");
  const candidatePostId = String(candidate?.bloggerPostId || "");
  if (!originalBlogId || !originalPostId) throw new Error("ORIGINAL_BLOGGER_IDENTITY_REQUIRED");
  if (originalBlogId !== candidateBlogId) throw new Error("BLOG_ID_CHANGED_DURING_REPAIR");
  if (originalPostId !== candidatePostId) throw new Error("BLOGGER_POST_ID_CHANGED_DURING_REPAIR");
  return true;
}
__name(assertExistingIdentity, "assertExistingIdentity");
