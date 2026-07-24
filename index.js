import express from "express";
import { chromium } from "playwright";

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 3000;
const AUTH_TOKEN = (process.env.X_AUTH_TOKEN || "").trim();
const CT0 = (process.env.X_CT0 || "").trim();
const AUTH_MULTI = (process.env.X_AUTH_MULTI || "").trim();
const TWID = (process.env.X_TWID || "").trim();

console.log("Env vars:", { AUTH_TOKEN: !!AUTH_TOKEN, CT0: !!CT0, AUTH_MULTI: !!AUTH_MULTI, TWID: !!TWID });
if (!AUTH_TOKEN || !CT0) {
  console.error("Missing X_AUTH_TOKEN or X_CT0 env vars");
  process.exit(1);
}

const BEARER = "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";

// 512MB instance: a persistent browser leaks until the container OOMs
// (searches started failing after 2-3 requests). Launch fresh per search and
// serialize requests so two browsers never coexist.
async function launchBrowser() {
  return chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-extensions",
      "--mute-audio",
      "--disable-background-networking",
      "--renderer-process-limit=2",
      "--js-flags=--max-old-space-size=192",
    ],
  });
}

let queue = Promise.resolve();
function enqueue(job) {
  const run = queue.then(job, job);
  queue = run.catch(() => {});
  return run;
}

const SEARCH_FEATURES = {
  rweb_video_screen_enabled: false,
  rweb_cashtags_enabled: true,
  profile_label_improvements_pcf_label_in_post_enabled: true,
  responsive_web_profile_redirect_enabled: false,
  rweb_tipjar_consumption_enabled: false,
  verified_phone_label_enabled: false,
  creator_subscriptions_tweet_preview_api_enabled: true,
  responsive_web_graphql_timeline_navigation_enabled: true,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  premium_content_api_read_enabled: false,
  communities_web_enable_tweet_community_results_fetch: true,
  c9s_tweet_anatomy_moderator_badge_enabled: true,
  responsive_web_grok_analyze_button_fetch_trends_enabled: false,
  responsive_web_grok_analyze_post_followups_enabled: true,
  rweb_cashtags_composer_attachment_enabled: true,
  responsive_web_jetfuel_frame: true,
  responsive_web_grok_share_attachment_enabled: true,
  responsive_web_grok_annotations_enabled: true,
  articles_preview_enabled: true,
  responsive_web_edit_tweet_api_enabled: true,
  rweb_conversational_replies_downvote_enabled: false,
  graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
  view_counts_everywhere_api_enabled: true,
  longform_notetweets_consumption_enabled: true,
  responsive_web_twitter_article_tweet_consumption_enabled: true,
  content_disclosure_indicator_enabled: true,
  content_disclosure_ai_generated_indicator_enabled: true,
  responsive_web_grok_show_grok_translated_post: true,
  responsive_web_grok_analysis_button_from_backend: true,
  post_ctas_fetch_enabled: false,
  freedom_of_speech_not_reach_fetch_enabled: true,
  standardized_nudges_misinfo: true,
  tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
  longform_notetweets_rich_text_read_enabled: true,
  longform_notetweets_inline_media_enabled: false,
  responsive_web_grok_image_annotation_enabled: true,
  responsive_web_grok_imagine_annotation_enabled: true,
  responsive_web_grok_community_note_auto_translation_is_enabled: true,
  responsive_web_enhance_cards_enabled: false,
};

function num(raw) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function parseSearch(data) {
  const posts = [];
  const instructions =
    data?.data?.search_by_raw_query?.search_timeline?.timeline?.instructions ?? [];

  for (const instruction of instructions) {
    for (const entry of instruction.entries ?? []) {
      if (!String(entry.entryId ?? "").startsWith("tweet-")) continue;

      let result = entry.content?.itemContent?.tweet_results?.result;
      if (!result) continue;
      if (result.__typename === "TweetWithVisibilityResults") result = result.tweet;
      const legacy = result?.legacy;
      if (!legacy || legacy.retweeted_status_result) continue;

      const core = result?.core?.user_results?.result;
      const handle = core?.legacy?.screen_name ?? core?.core?.screen_name ?? "";
      if (!handle) continue;

      const note = result?.note_tweet?.note_tweet_results?.result;
      const idStr = String(legacy.id_str ?? "");

      posts.push({
        author_handle: handle,
        url: `https://x.com/${handle}/status/${idStr}`,
        content: String(note?.text ?? legacy.full_text ?? "").trim(),
        posted_at: legacy.created_at ? new Date(legacy.created_at).toISOString() : null,
        likes: num(legacy.favorite_count),
        reposts: num(legacy.retweet_count),
        replies: num(legacy.reply_count),
        views: num(result?.views?.count),
      });
    }
  }
  return posts;
}

app.post("/search", (req, res) => {
  enqueue(() => runSearch(req, res)).catch((err) => {
    console.error(`[${Date.now()}] Queue error:`, err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  });
});

app.post("/profile", (req, res) => {
  enqueue(() => runProfile(req, res)).catch((err) => {
    console.error(`[${Date.now()}] Queue error:`, err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  });
});

app.post("/follow-list", (req, res) => {
  enqueue(() => runFollowList(req, res)).catch((err) => {
    console.error(`[${Date.now()}] Queue error:`, err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  });
});

async function runSearch(req, res) {
  const startTime = Date.now();
  let browserInstance = null;
  try {
    const { query, count = 20, qid } = req.body;
    if (!query) return res.status(400).json({ error: "Missing query" });

    console.log(`[${Date.now()}] Search: "${query}" qid=${qid || "(auto)"}`);

    browserInstance = await launchBrowser();
    const context = await browserInstance.newContext({
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
    });

    const cookies = [
      { name: "auth_token", value: AUTH_TOKEN, domain: ".x.com", path: "/" },
      { name: "ct0", value: CT0, domain: ".x.com", path: "/" },
    ];
    if (TWID) cookies.push({ name: "twid", value: TWID, domain: ".x.com", path: "/" });
    if (AUTH_MULTI) cookies.push({ name: "auth_multi", value: AUTH_MULTI, domain: ".x.com", path: "/" });
    await context.addCookies(cookies);

    // Drop heavy assets: X works fine without them and the free instance
    // can't afford the memory.
    await context.route("**/*", (route) => {
      const type = route.request().resourceType();
      if (type === "image" || type === "media" || type === "font") return route.abort();
      return route.continue();
    });

    const page = await context.newPage();

    // Capture the SearchTimeline response via route interception. The page's
    // own request also reveals the current qid, so the client never has to
    // hunt it down manually.
    let capturedData = null;
    let liveQid = qid || null;
    await page.route("**/api/graphql/**/SearchTimeline**", async (route) => {
      const match = route.request().url().match(/graphql\/([^/]+)\/SearchTimeline/);
      if (match) liveQid = match[1];
      const response = await route.fetch();
      const status = response.status();
      console.log(`[${Date.now()}] Intercepted SearchTimeline: ${status} qid=${liveQid}`);

      if (status === 200) {
        try {
          capturedData = await response.json();
        } catch (e) {
          console.error("Failed to parse response:", e.message);
        }
      }
      await route.fulfill({ response });
    });

    // Go straight to the search page: cookies are already injected and one
    // SPA boot is all the free instance can afford. The page itself fires
    // the SearchTimeline GraphQL call.
    const searchPageUrl = `https://x.com/search?q=${encodeURIComponent(query)}&src=typed_query`;
    console.log(`[${Date.now()}] Navigating to search: ${searchPageUrl}`);

    await page.goto(searchPageUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    // Slow CPU needs patience: poll up to 45s but bail as soon as we capture.
    for (let i = 0; i < 90 && !capturedData; i += 1) await page.waitForTimeout(500);

    // If route interception didn't catch it, try direct fetch (needs a qid,
    // either provided by the client or sniffed from the page's own request)
    if (!capturedData && liveQid) {
      console.log(`[${Date.now()}] Route interception missed, trying direct API call...`);

      const variables = {
        rawQuery: query,
        count: Math.min(count, 40),
        querySource: "typed_query",
        product: "Top",
        withGrokTranslatedBio: true,
        withQuickPromoteEligibilityTweetFields: false,
      };
      const searchUrl =
        `https://x.com/i/api/graphql/${liveQid}/SearchTimeline` +
        `?variables=${encodeURIComponent(JSON.stringify(variables))}` +
        `&features=${encodeURIComponent(JSON.stringify(SEARCH_FEATURES))}`;

      const result = await page.evaluate(async ({ url, bearer, csrf }) => {
        try {
          const resp = await fetch(url, {
            headers: {
              authorization: bearer,
              "x-csrf-token": csrf,
              "x-twitter-active-user": "yes",
              "x-twitter-auth-type": "OAuth2Session",
              "content-type": "application/json",
            },
            credentials: "include",
          });
          const text = await resp.text();
          return { status: resp.status, body: text };
        } catch (e) {
          return { status: 0, body: e.message };
        }
      }, { url: searchUrl, bearer: BEARER, csrf: CT0 });

      console.log(`[${Date.now()}] Direct API result: ${result.status}, body length: ${result.body.length}`);

      if (result.status === 200 && result.body) {
        try {
          capturedData = JSON.parse(result.body);
        } catch (e) {
          console.error("Failed to parse direct API response:", e.message);
        }
      }
    }

    const finalUrl = page.url();
    const finalTitle = await page.title().catch(() => "");

    if (!capturedData) {
      // Surface where the page actually landed so a login wall or challenge
      // is visible from the API response (Render logs are hard to reach).
      return res.status(502).json({
        error: "No se pudo obtener respuesta de X",
        diag: { url: finalUrl, title: finalTitle, qid: liveQid },
      });
    }

    const posts = parseSearch(capturedData);
    console.log(`[${Date.now()}] Found ${posts.length} posts in ${Date.now() - startTime}ms`);
    res.json({ posts, count: posts.length });
  } catch (err) {
    console.error(`[${Date.now()}] Search error:`, err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  } finally {
    if (browserInstance) await browserInstance.close().catch(() => {});
  }
}

function parseFollowers(data) {
  const result = data?.data?.user?.result;
  const legacy = result?.legacy ?? result?.core?.legacy;
  const n = num(legacy?.followers_count ?? result?.relationship_counts?.followers);
  return n || null;
}

function parseLatestTweet(data, handle) {
  const instructions =
    data?.data?.user?.result?.timeline_v2?.timeline?.instructions ??
    data?.data?.user?.result?.timeline?.timeline?.instructions ?? [];

  let latest = null;
  for (const instruction of instructions) {
    for (const entry of instruction.entries ?? []) {
      if (!String(entry.entryId ?? "").startsWith("tweet-")) continue;

      let result = entry.content?.itemContent?.tweet_results?.result;
      if (!result) continue;
      if (result.__typename === "TweetWithVisibilityResults") result = result.tweet;
      const legacy = result?.legacy;
      if (!legacy || legacy.retweeted_status_result) continue;

      const idStr = String(legacy.id_str ?? "");
      const postedAt = legacy.created_at ? new Date(legacy.created_at).toISOString() : null;
      if (!postedAt || !idStr) continue;
      if (!latest || postedAt > latest.posted_at) {
        latest = { url: `https://x.com/${handle}/status/${idStr}`, posted_at: postedAt };
      }
    }
  }
  return latest;
}

async function runProfile(req, res) {
  const startTime = Date.now();
  let browserInstance = null;
  try {
    const handle = String(req.body?.handle || "").replace(/^@/, "").trim();
    if (!handle) return res.status(400).json({ error: "Missing handle" });

    console.log(`[${Date.now()}] Profile: @${handle}`);

    browserInstance = await launchBrowser();
    const context = await browserInstance.newContext({
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
    });

    const cookies = [
      { name: "auth_token", value: AUTH_TOKEN, domain: ".x.com", path: "/" },
      { name: "ct0", value: CT0, domain: ".x.com", path: "/" },
    ];
    if (TWID) cookies.push({ name: "twid", value: TWID, domain: ".x.com", path: "/" });
    if (AUTH_MULTI) cookies.push({ name: "auth_multi", value: AUTH_MULTI, domain: ".x.com", path: "/" });
    await context.addCookies(cookies);

    await context.route("**/*", (route) => {
      const type = route.request().resourceType();
      if (type === "image" || type === "media" || type === "font") return route.abort();
      return route.continue();
    });

    const page = await context.newPage();

    // The profile page fires both UserByScreenName (header, has followers_count)
    // and UserTweets (timeline) on load; intercept both.
    let followers = null;
    let latestTweet = null;
    await page.route("**/api/graphql/**/UserByScreenName**", async (route) => {
      const response = await route.fetch();
      if (response.status() === 200) {
        try { followers = parseFollowers(await response.json()); } catch { /* ignore */ }
      }
      await route.fulfill({ response });
    });
    await page.route("**/api/graphql/**/UserTweets**", async (route) => {
      const response = await route.fetch();
      if (response.status() === 200) {
        try { latestTweet = parseLatestTweet(await response.json(), handle); } catch { /* ignore */ }
      }
      await route.fulfill({ response });
    });

    await page.goto(`https://x.com/${handle}`, { waitUntil: "domcontentloaded", timeout: 60000 });
    for (let i = 0; i < 90 && (followers === null || latestTweet === null); i += 1) await page.waitForTimeout(500);

    const finalUrl = page.url();
    const finalTitle = await page.title().catch(() => "");

    if (followers === null && latestTweet === null) {
      return res.status(502).json({
        error: "No se pudo obtener el perfil de X",
        diag: { url: finalUrl, title: finalTitle },
      });
    }

    console.log(`[${Date.now()}] Profile @${handle}: followers=${followers} latest=${latestTweet?.posted_at} in ${Date.now() - startTime}ms`);
    res.json({ followers, latest_post: latestTweet });
  } catch (err) {
    console.error(`[${Date.now()}] Profile error:`, err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  } finally {
    if (browserInstance) await browserInstance.close().catch(() => {});
  }
}

// Followers/Following timelines share the entry shape: "user-…" entries with
// a user_results payload.
function parseUserList(data) {
  const users = [];
  const instructions =
    data?.data?.user?.result?.timeline?.timeline?.instructions ??
    data?.data?.user?.result?.timeline_v2?.timeline?.instructions ?? [];
  for (const instruction of instructions) {
    for (const entry of instruction.entries ?? []) {
      if (!String(entry.entryId ?? "").startsWith("user-")) continue;
      const result = entry.content?.itemContent?.user_results?.result;
      if (!result) continue;
      const legacy = result.legacy ?? {};
      const core = result.core ?? {};
      const handle = legacy.screen_name ?? core.screen_name ?? "";
      if (!handle) continue;
      users.push({
        handle,
        name: legacy.name ?? core.name ?? "",
        bio: String(legacy.description ?? "").slice(0, 200),
        followers: num(legacy.followers_count ?? result?.relationship_counts?.followers),
        url: `https://x.com/${handle}`,
      });
    }
  }
  return users;
}

async function runFollowList(req, res) {
  const startTime = Date.now();
  let browserInstance = null;
  try {
    const handle = String(req.body?.handle || "").replace(/^@/, "").trim();
    const list = req.body?.list === "following" ? "following" : "followers";
    const target = Math.max(20, Math.min(400, Number(req.body?.count) || 200));
    if (!handle) return res.status(400).json({ error: "Missing handle" });

    console.log(`[${Date.now()}] Follow list: @${handle}/${list} target=${target}`);

    browserInstance = await launchBrowser();
    const context = await browserInstance.newContext({
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
    });

    const cookies = [
      { name: "auth_token", value: AUTH_TOKEN, domain: ".x.com", path: "/" },
      { name: "ct0", value: CT0, domain: ".x.com", path: "/" },
    ];
    if (TWID) cookies.push({ name: "twid", value: TWID, domain: ".x.com", path: "/" });
    if (AUTH_MULTI) cookies.push({ name: "auth_multi", value: AUTH_MULTI, domain: ".x.com", path: "/" });
    await context.addCookies(cookies);

    await context.route("**/*", (route) => {
      const type = route.request().resourceType();
      if (type === "image" || type === "media" || type === "font") return route.abort();
      return route.continue();
    });

    const page = await context.newPage();

    // Accumulate users across every intercepted page of the list. The
    // pattern matches Followers, BlueVerifiedFollowers and Following.
    const seen = new Map();
    const graphqlName = list === "following" ? "Following" : "Followers";
    await page.route(`**/api/graphql/**/*${graphqlName}*`, async (route) => {
      const response = await route.fetch();
      if (response.status() === 200) {
        try {
          for (const user of parseUserList(await response.json())) seen.set(user.handle, user);
        } catch { /* ignore */ }
      }
      await route.fulfill({ response });
    });

    await page.goto(`https://x.com/${handle}/${list}`, { waitUntil: "domcontentloaded", timeout: 60000 });
    for (let i = 0; i < 40 && seen.size === 0; i += 1) await page.waitForTimeout(500);

    // Infinite-scroll for more pages until the target or no growth.
    let stale = 0;
    while (seen.size > 0 && seen.size < target && stale < 3) {
      const before = seen.size;
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(1800);
      stale = seen.size === before ? stale + 1 : 0;
    }

    if (!seen.size) {
      return res.status(502).json({
        error: "No se pudo leer la lista",
        diag: { url: page.url(), title: await page.title().catch(() => "") },
      });
    }

    const users = [...seen.values()];
    console.log(`[${Date.now()}] @${handle}/${list}: ${users.length} users in ${Date.now() - startTime}ms`);
    res.json({ users, count: users.length, list });
  } catch (err) {
    console.error(`[${Date.now()}] Follow list error:`, err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  } finally {
    if (browserInstance) await browserInstance.close().catch(() => {});
  }
}

app.get("/health", (_, res) => res.json({ ok: true }));

process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));

app.listen(PORT, () => console.log(`X search server on :${PORT}`));
