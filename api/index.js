// FINAL VERSION: Uses live data from YouTube and Reddit, with OpenAI for AI tasks.

// --- API CLIENTS ---

const searchYouTubeVideos = async (query, apiKey, maxResults = 3) => {
  const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(query)}&type=video&order=relevance&maxResults=${maxResults}&key=${apiKey}`;
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`YouTube API Error: ${response.statusText}`);
    const data = await response.json();
    return data.items?.map(item => ({ title: item.snippet.title })) || [];
  } catch (error) {
    console.error(`Error searching YouTube for "${query}":`, error.message);
    return [];
  }
};

const getChannelVideos = async (channelName, apiKey, maxResults = 3) => {
  try {
    const channelSearchUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(channelName)}&type=channel&maxResults=1&key=${apiKey}`;
    const channelResponse = await fetch(channelSearchUrl).then(res => res.json());
    if (!channelResponse.items || channelResponse.items.length === 0) {
      console.warn(`YouTube channel not found: ${channelName}`);
      return [];
    }
    const channelId = channelResponse.items[0].id.channelId;
    const videosUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=${channelId}&type=video&order=date&maxResults=${maxResults}&key=${apiKey}`;
    const videosResponse = await fetch(videosUrl).then(res => res.json());
    return videosResponse.items?.map(item => ({ title: item.snippet.title })) || [];
  } catch (error) {
    console.error(`Error fetching videos for channel "${channelName}":`, error.message);
    return [];
  }
};

let redditToken = { value: null, expires: 0 };

const getRedditAccessToken = async (clientId, clientSecret) => {
  if (redditToken.value && redditToken.expires > Date.now()) { return redditToken.value; }
  const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const url = 'https://www.reddit.com/api/v1/access_token';
  const options = {
    method: 'POST',
    headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'ExonVercel/1.0' },
    body: 'grant_type=client_credentials',
  };
  try {
    const response = await fetch(url, options).then(res => res.json());
    if (!response.access_token) throw new Error('Reddit token not received.');
    redditToken = { value: response.access_token, expires: Date.now() + 50 * 60 * 1000 };
    return redditToken.value;
  } catch (error) {
    console.error('Reddit token error:', error.message);
    return null;
  }
};

const getSubredditPosts = async (subreddit, accessToken, limit = 3) => {
  const url = `https://oauth.reddit.com/r/${subreddit}/hot?limit=${limit}`;
  const options = { headers: { 'Authorization': `Bearer ${accessToken}`, 'User-Agent': 'ExonVercel/1.0' } };
  try {
    const response = await fetch(url, options).then(res => res.json());
    return response.data?.children?.map(post => ({ title: post.data.title })) || [];
  } catch (error) {
    console.error(`Error fetching posts from r/${subreddit}:`, error.message);
    return [];
  }
};

const callOpenAI_API = async (prompt, apiKey) => {
  const url = 'https://api.openai.com/v1/chat/completions';
  const requestBody = {
    model: "gpt-3.5-turbo",
    messages: [{ "role": "user", "content": prompt }],
    response_format: { "type": "json_object" }
  };
  const options = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify(requestBody),
  };
  try {
    const response = await fetch(url, options);
    if (!response.ok) throw new Error(`OpenAI API Error: ${response.statusText}`);
    const data = await response.json();
    return JSON.parse(data.choices[0].message.content);
  } catch (error) {
    console.error('OpenAI API error:', error.message);
    throw new Error('Failed to get a valid response from the OpenAI API.');
  }
};

// --- MAIN SERVERLESS HANDLER ---
module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(204).end();
  }

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const { audience, goal, competitorYouTubeChannels, relevantSubreddits } = req.body || {};
    if (!audience || !goal || !Array.isArray(competitorYouTubeChannels) || !Array.isArray(relevantSubreddits)) {
      return res.status(400).json({ error: 'Invalid request body. Ensure all required fields are present.' });
    }
    
    const { YOUTUBE_API_KEY, REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET, OPENAI_API_KEY } = process.env;
    if (!YOUTUBE_API_KEY || !REDDIT_CLIENT_ID || !REDDIT_CLIENT_SECRET || !OPENAI_API_KEY) {
      console.error("CRITICAL: Missing one or more environment variables.");
      return res.status(500).json({ error: 'Server configuration error.' });
    }

    // --- Data Collection (YouTube & Reddit) ---
    console.log("Starting data collection from YouTube and Reddit...");
    const [topVideos, competitorVideosData, redditPostsData] = await Promise.all([
        searchYouTubeVideos(`${audience} ${goal}`, YOUTUBE_API_KEY, 3),
        Promise.all(competitorYouTubeChannels.map(channel => getChannelVideos(channel, YOUTUBE_API_KEY, 3).then(videos => ({ channel, videos })))),
        getRedditAccessToken(REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET).then(token => 
            token ? Promise.all(relevantSubreddits.map(sub => getSubredditPosts(sub.replace('r/',''), token, 3).then(posts => ({ subreddit: sub, posts })))) : []
        )
    ]);
    
    // --- Master Prompt Construction ---
    const topVideoTitles = topVideos.map(v => v.title).join(', ');
    const competitorVideoTitles = competitorVideosData.map(c => `${c.channel}: ${c.videos.map(v => v.title).join(', ')}`).join(' | ');
    const redditPostTitles = redditPostsData.map(s => `${s.subreddit}: ${s.posts.map(p => p.title).join(', ')}`).join(' | ');

    const masterPrompt = `
You are a world-class content strategist and data analyst named Exon. Your task is to generate a complete content strategy.
I have provided real-time data from YouTube and Reddit. You must simulate the data for X (Twitter) and Google Trends based on your expert knowledge.

Client Details:
- Target Audience: ${audience}
- Primary Goal: ${goal}

Live Data Collected:
- Top YouTube Videos: ${topVideoTitles || "No data collected."}
- Competitor YouTube Videos: ${competitorVideoTitles || "No data collected."}
- Top Reddit Posts: ${redditPostTitles || "No data collected."}

Based on all of this, provide a response in a single, valid JSON object with the following four keys: "trendDiscovery", "contentAnalysis", "competitorReport", "strategyCalendar".

1. "trendDiscovery": An object for trend analysis.
   - "youtubeTrends": Analyze the provided LIVE YouTube data to identify 3-5 key trends.
   - "redditTrends": Analyze the provided LIVE Reddit data to identify 3-5 key community topics.
   - "simulatedXTrends": Act as an expert on X (Twitter). Simulate the top 3-5 trending topics relevant to the target audience.
   - "simulatedGoogleTrends": Act as a search analyst. Simulate the top 3-5 rising search queries on Google Trends.

2. "contentAnalysis": An object that deconstructs successful content (winningFormats, toneOfVoice, engagementTriggers, optimalTiming).

3. "competitorReport": An object analyzing the specified competitors (youtubeCompetitorAnalysis, inferredXStrategy).

4. "strategyCalendar": An array of 30 objects for a 30-day content plan. Each object must have the following structure: { "day": number, "platform": "YouTube/Instagram/Reddit", "title": "A catchy, fully-formed content title", "format": "e.g., YouTube Short, IG Reel", "description": "A 1-2 sentence description." }
`;

    // --- AI Analysis ---
    console.log("Calling OpenAI API for final analysis...");
    const openAIResponse = await callOpenAI_API(masterPrompt, OPENAI_API_KEY);

    res.setHeader('Content-Type', 'application/json');
    res.status(200).json(openAIResponse);

  } catch (error) {
    console.error("FATAL_ERROR in handler:", error);
    res.status(500).json({ error: 'An internal server error occurred.', details: error.message });
  }
};
