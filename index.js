import express from "express";
import { chromium } from "playwright";

const app = express();
app.use(express.json());

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

let browser = null;

async function getBrowser() {
  if (!browser) {
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
  }
  return browser;
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
      const handle =
        core?.legacy?.screen_name ?? core?.core?.screen_name ?? "";
      if (!handle) continue;

      const note = result?.note_tweet?.note_tweet_results?.result;
      const idStr = String(legacy.id_str ?? "");

      posts.push({
        author_handle: handle,
        url: `https://x.com/${handle}/status/${idStr}`,
        content: String(note?.text ?? legacy.full_text ?? "").trim(),
        posted_at: legacy.created_at
          ? new Date(legacy.created_at).toISOString()
          : null,
        likes: num(legacy.favorite_count),
        reposts: num(legacy.retweet_count),
        replies: num(legacy.reply_count),
        views: num(result?.views?.count),
      });
    }
  }
  return posts;
}

app.post("/search", async (req, res) => {
  try {
    const { query, count = 20, qid } = req.body;
    if (!query) return res.status(400).json({ error: "Missing query" });
    if (!qid) return res.status(400).json({ error: "Missing qid" });

    const variables = {
      rawQuery: query,
      count: Math.min(count, 40),
      querySource: "typed_query",
      product: "Top",
      withGrokTranslatedBio: true,
      withQuickPromoteEligibilityTweetFields: false,
    };

    const url =
      `https://x.com/i/api/graphql/${qid}/SearchTimeline` +
      `?variables=${encodeURIComponent(JSON.stringify(variables))}` +
      `&features=${encodeURIComponent(JSON.stringify(SEARCH_FEATURES))}`;

    const browserInstance = await getBrowser();
    const context = await browserInstance.newContext({
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
    });

    // Set cookies
    const cookies = [
      { name: "auth_token", value: AUTH_TOKEN, domain: ".x.com", path: "/" },
      { name: "ct0", value: CT0, domain: ".x.com", path: "/" },
    ];
    if (TWID) cookies.push({ name: "twid", value: TWID, domain: ".x.com", path: "/" });
    if (AUTH_MULTI) cookies.push({ name: "auth_multi", value: AUTH_MULTI, domain: ".x.com", path: "/" });
    await context.addCookies(cookies);

    const page = await context.newPage();

    // Intercept the GraphQL response
    let responseData = null;
    page.on("response", async (response) => {
      if (response.url().includes("SearchTimeline")) {
        try {
          responseData = await response.json();
        } catch {}
      }
    });

    // Navigate to x.com to establish session, then make the API call
    await page.goto("https://x.com/home", { waitUntil: "domcontentloaded", timeout: 15000 });
    await page.waitForTimeout(2000);

    // Make the API call via fetch in the page context
    const BEARER = "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";
    
    const apiResult = await page.evaluate(async ({ url, bearer, csrf }) => {
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
      return { status: resp.status, body: await resp.json() };
    }, { url, bearer: BEARER, csrf: CT0 });

    await page.close();
    await context.close();

    if (apiResult.status === 404) {
      return res.status(400).json({ error: "Query ID vencido — actualizá el QID" });
    }
    if (apiResult.status !== 200) {
      return res.status(502).json({ error: `X respondió ${apiResult.status}` });
    }

    const posts = parseSearch(apiResult.body);
    res.json({ posts, count: posts.length });
  } catch (err) {
    console.error("Search error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/health", (_, res) => res.json({ ok: true }));

// Graceful shutdown
process.on("SIGTERM", async () => {
  if (browser) await browser.close();
  process.exit(0);
});

app.listen(PORT, () => console.log(`X search server on :${PORT}`));
