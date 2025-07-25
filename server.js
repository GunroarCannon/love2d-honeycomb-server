// === ENV + SETUP ===
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createEdgeClient } = require('@honeycomb-protocol/edge-client');
const {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  SystemProgram,
  sendAndConfirmTransaction
} = require('@solana/web3.js');

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize Honeycomb client
const honeycombClient = createEdgeClient(
  process.env.HONEYCOMB_API_URL || 'https://edge.main.honeycombprotocol.com/',
  true // enable logging
);

// Solana connection
const connection = new Connection(
  process.env.SOLANA_RPC || 'https://api.devnet.solana.com',
  'confirmed'
);

// Treasury wallet
const treasurerWallet = Keypair.fromSecretKey(
  new Uint8Array(JSON.parse(process.env.TREASURER_PRIVATE_KEY))
);

app.use(cors());
app.use(express.json());

// === IN-MEMORY STORE ===
const challengeStore = {
  currentDate: '',
  challenges: [],
  playerProgress: {} // { wallet: { challengeId: progress } }
};

// === HONEYCOMB PROJECT CONFIG ===
const PROJECT_CONFIG = {
  name: "DailyChallengesGame",
  achievements: ["ChallengeMaster", "DailyPlayer", "WeekStreak"],
  customFields: ["TotalPoints", "LastPlayed", "ChallengeStreak"]
};

// === INITIALIZE PROJECT ===
async function initializeHoneycombProject() {
  try {
    const { tx } = await honeycombClient.createCreateProjectTransaction({
      name: PROJECT_CONFIG.name,
      authority: treasurerWallet.publicKey,
      profileDataConfig: {
        achievements: PROJECT_CONFIG.achievements,
        customDataFields: PROJECT_CONFIG.customFields
      }
    });
    
    const signature = await sendAndConfirmTransaction(
      connection,
      tx,
      [treasurerWallet]
    );
    
    console.log("Project initialized:", signature);
  } catch (err) {
    console.error("Project initialization failed:", err);
  }
}

// === GENERATE DAILY CHALLENGES ===
function generateDailyChallenges() {
  const verbs = ['Defeat', 'Collect', 'Survive', 'Complete'];
  const targets = ['enemies', 'coins', 'minutes', 'levels'];
  
  return Array.from({ length: 3 }, (_, i) => {
    const verb = verbs[Math.floor(Math.random() * verbs.length)];
    const target = targets[Math.floor(Math.random() * targets.length)];
    const amount = Math.floor(Math.random() * 5) + 3; // 3-7
    const reward = amount * 10; // 10 points per unit
    
    return {
      id: `daily_${Date.now()}_${i}`,
      verb,
      target,
      amount,
      reward,
      badgeIndex: i // Maps to Honeycomb badge
    };
  });
}

// === ROUTES ===

// Get today's challenges
app.get('/challenges', async (req, res) => {
  const today = new Date().toDateString();
  
  if (challengeStore.currentDate !== today) {
    challengeStore.currentDate = today;
    challengeStore.challenges = generateDailyChallenges();
    challengeStore.playerProgress = {};
    
    // Create Honeycomb badges for new challenges
    await createHoneycombBadges(challengeStore.challenges);
  }
  
  res.json(challengeStore.challenges);
});

// Connect wallet
app.post('/connect', async (req, res) => {
  const { walletAddress } = req.body;
  
  try {
    // Verify wallet exists on chain
    const pubkey = new PublicKey(walletAddress);
    const accountInfo = await connection.getAccountInfo(pubkey);
    if (!accountInfo) throw new Error('Wallet not found');
    
    // Initialize or load player profile
    const profile = await getOrCreateProfile(walletAddress);
    
    res.json({
      wallet: walletAddress,
      challenges: challengeStore.challenges,
      progress: challengeStore.playerProgress[walletAddress] || {},
      profile
    });
    
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Update challenge progress
app.post('/progress', async (req, res) => {
  const { walletAddress, challengeId, progress } = req.body;
  
  try {
    const challenge = challengeStore.challenges.find(c => c.id === challengeId);
    if (!challenge) throw new Error('Challenge not found');
    
    // Initialize progress tracking
    if (!challengeStore.playerProgress[walletAddress]) {
      challengeStore.playerProgress[walletAddress] = {};
    }
    
    const playerProgress = challengeStore.playerProgress[walletAddress][challengeId] || {
      completed: 0,
      claimed: false
    };
    
    // Update progress
    playerProgress.completed += progress;
    
    // Check for completion
    if (playerProgress.completed >= challenge.amount && !playerProgress.claimed) {
      // Award Honeycomb badge
      await awardBadge(walletAddress, challenge.badgeIndex);
      
      // Update player stats
      await updatePlayerStats(walletAddress, challenge.reward);
      
      playerProgress.claimed = true;
    }
    
    challengeStore.playerProgress[walletAddress][challengeId] = playerProgress;
    
    res.json({ 
      progress: playerProgress,
      completed: playerProgress.completed >= challenge.amount
    });
    
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Claim rewards
app.post('/claim', async (req, res) => {
  const { walletAddress } = req.body;
  
  try {
    // Verify completed challenges
    const completions = Object.entries(challengeStore.playerProgress[walletAddress] || {})
      .filter(([_, progress]) => progress.completed && !progress.claimed);
    
    if (completions.length === 0) {
      throw new Error('No rewards to claim');
    }
    
    // Calculate total reward
    const totalReward = completions.reduce((sum, [challengeId, _]) => {
      const challenge = challengeStore.challenges.find(c => c.id === challengeId);
      return sum + (challenge?.reward || 0);
    }, 0);
    
    // Distribute rewards
    await distributeRewards(walletAddress, totalReward);
    
    // Mark as claimed
    completions.forEach(([challengeId, _]) => {
      challengeStore.playerProgress[walletAddress][challengeId].claimed = true;
    });
    
    res.json({ 
      success: true,
      reward: totalReward 
    });
    
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// === HONEYCOMB HELPERS ===

async function getOrCreateProfile(walletAddress) {
  try {
    // Check for existing profile
    const profile = await honeycombClient.getProfile({
      project: process.env.HONEYCOMB_PROJECT_ID,
      wallet: walletAddress
    });
    
    return profile;
  } catch {
    // Create new profile
    const { tx } = await honeycombClient.createCreateProfileTransaction({
      project: process.env.HONEYCOMB_PROJECT_ID,
      wallet: walletAddress
    });
    
    await sendAndConfirmTransaction(connection, tx, [treasurerWallet]);
    return await honeycombClient.getProfile({
      project: process.env.HONEYCOMB_PROJECT_ID,
      wallet: walletAddress
    });
  }
}

async function createHoneycombBadges(challenges) {
  for (const challenge of challenges) {
    await honeycombClient.createCreateBadgeCriteriaTransaction({
      badgeIndex: challenge.badgeIndex,
      condition: "Public",
      startTime: Math.floor(Date.now() / 1000),
      endTime: Math.floor(Date.now() / 1000) + 86400 // 24 hours
    });
  }
}

async function awardBadge(walletAddress, badgeIndex) {
  await honeycombClient.createClaimBadgeCriteriaTransaction({
    profileAddress: walletAddress,
    criteriaIndex: badgeIndex,
    proof: "Public"
  });
}

async function updatePlayerStats(walletAddress, points) {
  await honeycombClient.createSetCustomDataTransaction({
    wallet: walletAddress,
    customData: {
      TotalPoints: { $inc: points },
      LastPlayed: new Date().toISOString(),
      ChallengeStreak: { $inc: 1 }
    }
  });
}

async function distributeRewards(walletAddress, amount) {
  // On-chain transfer
  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: treasurerWallet.publicKey,
      toPubkey: new PublicKey(walletAddress),
      lamports: Math.floor(amount * LAMPORTS_PER_SOL * 0.001) // Scale for devnet
    })
  );
  
  await sendAndConfirmTransaction(connection, tx, [treasurerWallet]);
  
  // Update Honeycomb profile
  await honeycombClient.createSetAchievementTransaction({
    wallet: walletAddress,
    achievement: "DailyPlayer",
    achieved: true
  });
}

// === START SERVER ===
app.listen(PORT, async () => {
  console.log(`Server running on http://localhost:${PORT}`);
  
  // Initialize Honeycomb project on startup
  await initializeHoneycombProject();
  
  // Generate first set of challenges
  challengeStore.currentDate = new Date().toDateString();
  challengeStore.challenges = generateDailyChallenges();
  await createHoneycombBadges(challengeStore.challenges);
  
  console.log('Daily challenges ready:', challengeStore.challenges);
});
