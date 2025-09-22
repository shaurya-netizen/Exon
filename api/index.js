// A robust, single-file serverless function for the AI Content Strategy Engine.
// This version uses Node.js's built-in fetch for cleaner, more reliable requests.

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
  if (redditToken.value && redditToken.expires > Date.now()) {
    return redditToken.value;
  }

  const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const url = 'https://www.reddit.com/api/v1/access_token';
  const options = {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'VercelContentStrategyEngine/1.0',
    },
    body: 'grant_type=client_credentials',
  };

  try {
    const response = await fetch(url, options).then(res => res.json());
    if (!response.access_token) throw new Error('Reddit token not received.');
    
    redditToken = {
      value: response.access_token,
      expires: Date.now() + 50 * 60 * 1000,
    };
    return redditToken.value;
  } catch (error) {
    console.error('Reddit token error:', error.message);
    return null;
  }
};

const getSubredditPosts = async (subreddit, accessToken, limit = 3) => {
  const url = `https://oauth.reddit.com/r/${subreddit}/hot?limit=${limit}`;
  const options = {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'User-Agent': 'VercelContentStrategyEngine/1.0',
    },
  };

  try {
    const response = await fetch(url, options).then(res => res.json());
    return response.data?.children?.map(post => ({ title: post.data.title })) || [];
  } catch (error) {
    console.error(`Error fetching posts from r/${subreddit}:`, error.message);
    return [];
  }
};

const callGeminiAPI = async (prompt, apiKey) => {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${apiKey}`;
  const requestBody = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { responseMimeType: "application/json" }
  };

  const options = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody),
  };

  try {
    const response = await fetch(url, options);
    if (!response.ok) throw new Error(`Gemini API Error: ${response.statusText}`);
    const data = await response.json();
    return JSON.parse(data.candidates[0].content.parts[0].text);
  } catch (error) {
    console.error('Gemini API error:', error.message);
    throw new Error('Failed to get a valid response from the Gemini API.');
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

  // Set CORS headers for the actual request
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
    
    const { YOUTUBE_API_KEY, REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET, GEMINI_API_KEY } = process.env;
    if (!YOUTUBE_API_KEY || !REDDIT_CLIENT_ID || !REDDIT_CLIENT_SECRET || !GEMINI_API_KEY) {
      console.error("CRITICAL: Missing one or more environment variables.");
      return res.status(500).json({ error: 'Server configuration error.' });
    }

    const [topVideos, competitorVideosData, redditPostsData] = await Promise.all([
      searchYouTubeVideos(`${audience} ${goal}`, YOUTUBE_API_KEY, 3),
      Promise.all(competitorYouTubeChannels.map(channel => getChannelVideos(channel, YOUTUBE_API_KEY, 3).then(videos => ({ channel, videos })))),
      getRedditAccessToken(REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET).then(token => 
        token ? Promise.all(relevantSubreddits.map(sub => getSubredditPosts(sub.replace('r/',''), token, 3).then(posts => ({ subreddit: sub, posts })))) : []
      )
    ]);
    
    const topVideoTitles = topVideos.map(v => v.title).join(', ');
    const competitorVideoTitles = competitorVideosData.map(c => `${c.channel}: ${c.videos.map(v => v.title).join(', ')}`).join(' | ');
    const redditPostTitles = redditPostsData.map(s => `${s.subreddit}: ${s.posts.map(p => p.title).join(', ')}`).join(' | ');

    const masterPrompt = `
You are a world-class content strategist and data analyst. I have gathered real-time data from YouTube and Reddit for a client. Your task is to generate a complete content strategy based on this data and your own expert knowledge.

Client Details:
- Target Audience: ${audience}
- Primary Goal: ${goal}

Live Data Collected:
- Top YouTube Videos: ${topVideoTitles || "N/A"}
- Competitor YouTube Videos: ${competitorVideoTitles || "N/A"}
- Top Reddit Posts: ${redditPostTitles || "N/A"}

Based on all of this, provide a response in a single JSON object with the following four keys: "trendDiscovery", "contentAnalysis", "competitorReport", "strategyCalendar".

1. "trendDiscovery": An object containing trend analysis from four key platforms.
   - "youtubeTrends": Analyze the provided YouTube data to identify 3-5 key trends.
   - "redditTrends": Analyze the provided Reddit data to identify 3-5 key community topics and sentiments.
   - "simulatedXTrends": Act as an expert on X (Twitter). Based on your knowledge, simulate the top 3-5 trending topics and content formats (e.g., threads, memes) relevant to the target audience on X right now.
   - "simulatedGoogleTrends": Act as an expert search analyst. Based on your knowledge, simulate the top 3-5 rising search queries on Google Trends relevant to the target audience.

2. "contentAnalysis": An object that deconstructs what makes high-performing content successful.
   - "winningFormats": Identify the most effective content formats.
   - "toneOfVoice": Describe the most successful tone of voice.
   - "engagementTriggers": List common engagement triggers.
   - "optimalTiming": Suggest the best days and times to post.

3. "competitorReport": An object analyzing the specified competitors.
   - "youtubeCompetitorAnalysis": Summarize their content strategy, topic focus, and posting frequency.
   - "inferredXStrategy": Infer what their strategy on X would likely be.

4. "strategyCalendar": An array of 30 objects, representing a full 30-day content plan. Each object must have the following structure: { "day": number, "platform": "YouTube/Instagram/Reddit", "title": "A catchy, fully-formed content title", "format": "e.g., YouTube Short, IG Reel, Reddit Thread", "description": "A 1-2 sentence description." }
`;

    const geminiResponse = await callGeminiAPI(masterPrompt, GEMINI_API_KEY);

    res.setHeader('Content-Type', 'application/json');
    res.status(200).json(geminiResponse);

  } catch (error) {
    console.error("FATAL_ERROR in handler:", error);
    res.status(500).json({ error: 'An internal server error occurred.', details: error.message });
  }
};
