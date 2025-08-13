// === ENV + SETUP ===
require("dotenv").config();
console.log("[INIT] .env loaded");

// Dependencies
const express = require("express");
const cors = require("cors");
const bs58 = require("bs58");
const { createEdgeClient } = require("@honeycomb-protocol/edge-client");
const {
    sendTransactionsForTests: sendTransactionsT,
    sendTransactionForTests: sendTransactionT,
} = require("@honeycomb-protocol/edge-client/client/helpers");

const {
    Connection,
    Keypair,
    PublicKey,
    Message,
    Transaction,
    LAMPORTS_PER_SOL,
} = require("@solana/web3.js");
const nacl = require("tweetnacl");

function verifySignature(message, signature, publicKey) {
    try {
        // Convert inputs
        const publicKeyBytes = new PublicKey(publicKey).toBytes();
        const signatureBytes = Uint8Array.from(
            signature.split(",").map(Number),
        );
        const messageBytes = new TextEncoder().encode(message);

        // Verify using nacl
        return nacl.sign.detached.verify(
            messageBytes,
            signatureBytes,
            publicKeyBytes,
        );
    } catch (err) {
        console.error("Verification error:", err);
        return false;
    }
}
function verifySignasture(message, signature, publicKey) {
    try {
        // Convert string signature back to Uint8Array
        const signatureArray = new Uint8Array(signature.split(",").map(Number));

        // Reconstruct the signed message
        const tx = Transaction.populate(Message.from(Buffer.from(message)));
        tx.addSignature(new PublicKey(publicKey), signatureArray);

        return tx.verifySignatures();
    } catch (err) {
        console.error("Signature verification failed:", err);
        return false;
    }
}

console.log("[INIT] Loaded dependencies", { edgeClient: !!createEdgeClient });

// App setup
const app = express();
const PORT = process.env.PORT || 3000;

app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "*");
    res.header("Access-Control-Allow-Methods", "GET, POST");
    next();
});

app.use(cors());
app.use(express.json());

// Log all incoming requests
app.use((req, res, next) => {
    const start = Date.now();

    // Clone the request body for logging (since the stream can only be read once)
    let body = {};
    if (req.method !== "GET" && req.body) {
        body = JSON.parse(JSON.stringify(req.body));
        // Mask sensitive fields if needed
        if (body.signature) body.signature = "*****";
        if (body.privateKey) body.privateKey = "*****";
    }

    // Log the incoming request
    console.log(`[CALLING] ${req.method} ${req.originalUrl}`);
    const tmp = {
        headers: req.headers,
        query: req.query,
        body: body,
        ip: req.ip,
    };

    // Store original functions
    const oldSend = res.send;
    const oldJson = res.json;

    // Intercept responses
    /*res.send = function (data) {
        console.log(`${req.method} ${req.originalUrl} -> ${res.statusCode}`, {
            duration: `${Date.now() - start}ms`,
            response:
                typeof data === "string"
                    ? data
                    : JSON.stringify(data).slice(0, 500) +
                      (JSON.stringify(data).length > 500 ? "..." : ""),
        });
        oldSend.apply(res, arguments);
    };

    res.jsosn = function (data) {
        console.log(` ${req.method} ${req.originalUrl} -> ${res.statusCode}`, {
            duration: `${Date.now() - start}ms`,
            response:
                JSON.stringify(data).slice(0, 500) +
                (JSON.stringify(data).length > 500 ? "..." : ""),
        });
        oldJson.apply(res, arguments);
    };
    */

    next();
});

// Initialize challenge store
const challengeStore = {
    currentDate: new Date().toDateString(),
    challenges: [],
    playerProgress: {},
};

// Initialize Solana connection
const connection = new Connection(
    !process.env.SOLANA_RPC || "https://rpc.test.honeycombprotocol.com",
    "confirmed",
);
console.log(`[NETWORK] Connected to Solana RPC: ${connection.rpcEndpoint}`);

// Initialize Honeycomb client with debug
const honeycombClient = createEdgeClient(
    process.env.HONEYCOMB_API_URL || "https://edge.test.honeycombprotocol.com",
    true,
);
console.log("[HONEYCOMB] Client initialized:", {
    apiUrl: honeycombClient.apiUrl,
    network: honeycombClient.network,
});

// Treasurer wallet
let treasurerWallet;
try {
    treasurerWallet = Keypair.fromSecretKey(
        new Uint8Array(JSON.parse(process.env.TREASURER_PRIVATE_KEY)),
    );
    console.log(
        "[WALLET] Treasurer initialized:",
        treasurerWallet.publicKey.toBase58(),
    );
} catch (err) {
    console.error("[WALLET] Invalid private key:", err);
    process.exit(1);
}

// === Helper: Strict check ===
function assertTx(result, label = "") {
    if (!result || !result.tx) {
        console.error(`[ASSERT] Missing tx in result${label || ""}`, result);
        throw new Error(`Missing tx in Honeycomb response${label}`);
    }
    return result;
}

// === Initialize Project ===
let honeycombProject;
async function initializeProject() {
    console.log("[PROJECT] Starting initialization...");

    try {
        const balance = await connection.getBalance(treasurerWallet.publicKey);
        console.log(
            `[PROJECT] Treasurer balance: ${balance / LAMPORTS_PER_SOL} SOL`,
        );

        const projectConfig = {
            name: `DailyGame_${Date.now()}`,
            authority: treasurerWallet.publicKey.toString(),
            payer: treasurerWallet.publicKey.toString(),
            subsidizeFees: true, // Recommended for testnet
        };
        console.log(
            "[PROJECT] Config:",
            JSON.stringify(projectConfig, null, 2),
        );

        console.log("project making");
        const { createCreateProjectTransaction } =
            await honeycombClient.createCreateProjectTransaction(projectConfig);

        console.log("project made");
        const txToSend = {
            ...createCreateProjectTransaction.tx,
            feePayer: treasurerWallet.publicKey.toString(), // Must include feePayer
        };

        // 2. Send transaction using test helper
        const { project: projectAddress } = createCreateProjectTransaction;
        await sendTransactionT(
            honeycombClient,
            txToSend,
            [treasurerWallet],
            //connection
        );
        console.log("Project created ", projectAddress);
        const pp = await honeycombClient.findProjects({
            addresses: [projectAddress],
        });
        console.log(pp);

        console.log(`- Address: ${projectAddress}`);
        //console.log(`- TX: https://explorer.solana.com/tx/${signature}?cluster=devnet`);

        return projectAddress;
    } catch (err) {
        console.error("[FATAL] Project initialization failed:", err);
        throw err;
    }
}

async function createProfilesTree(project) {
    const { createCreateProfilesTreeTransaction } =
        await honeycombClient.createCreateProfilesTreeTransaction({
            payer: treasurerWallet.publicKey.toString(),
            project: project.toString(),
            treeConfig: { basic: { numAssets: 100000 } },
        });

    await sendTransactionT(
        honeycombClient,
        {
            ...createCreateProfilesTreeTransaction.tx,
            feePayer: treasurerWallet.publicKey.toString(),
        },
        [treasurerWallet],
    );

    console.log("[INIT] Profiles tree created");
}

async function getExistingProject(projectKey) {
    console.log("[PROJECT] Attempting to fetch existing project...");

    try {
        // First check if we have a project key
        if (projectKey) {
            console.log(`[PROJECT] Checking project: ${projectKey}`);

            // 1. Verify on-chain existence
            const projectPubkey = new PublicKey(projectKey);
            const accountInfo = await connection.getAccountInfo(projectPubkey);

            if (!accountInfo) {
                //throw new Error("Project account not found on-chain");
            }

            // 2. Verify in Honeycomb index
            const { project: foundProjects } =
                await honeycombClient.findProjects({
                    addresses: [projectKey],
                });
            const p = await honeycombClient.findProjects({
                addresses: [projectKey],
            });
            if (!foundProjects || foundProjects.length === 0) {
                throw new Error("Project not found in Honeycomb index");
            }

            console.log(`[PROJECT] Verified existing project: ${projectKey}`);
            return projectPubkey;
        }

        // Fallback: Search by authority if no projectKey provided
        console.log("[PROJECT] Searching projects by authority...");
        const { project: authorityProjects } =
            await honeycombClient.findProjects({
                authorities: [treasurerWallet.publicKey.toString()],
            });

        if (authorityProjects && authorityProjects.length > 0) {
            // Sort by newest first (assuming createdAt is available)
            const sortedProjects = authorityProjects.sort(
                (a, b) => new Date(b.createdAt) - new Date(a.createdAt),
            );

            const newestProject = sortedProjects[0];
            console.log(
                `[PROJECT] Found project by authority: ${newestProject.address}`,
            );
            return new PublicKey(newestProject.address);
        }

        throw new Error("No existing projects found");
    } catch (err) {
        console.error("[PROJECT] Fetch error:", err);
        throw err;
    }
}

// === GAME LOGIC ===
function generateDailyChallenges() {
    console.log("[GAME] Generating new daily challenges...");
    const verbs = ["Defeat", "Collect", "Complete"];
    const targets = ["enemies", "coins", "levels"];

    const challenges = Array.from({ length: 3 }, (_, i) => ({
        id: `daily_${Date.now()}_${i}`,
        verb: verbs[Math.floor(Math.random() * verbs.length)],
        target: targets[Math.floor(Math.random() * targets.length)],
        amount: Math.floor(Math.random() * 5) + 3,
        reward: (Math.floor(Math.random() * 5) + 3) * 10,
        badgeIndex: i,
    }));

    console.log("[GAME] Generated challenges:", challenges);
    return challenges;
}

// === ROUTES ===
app.get("/challenges", async (req, res) => {
    console.log("[API] GET /challenges request received");
    const today = new Date().toDateString();

    if (challengeStore.currentDate !== today) {
        console.log("[GAME] New day detected - resetting challenges");
        challengeStore.currentDate = today;
        challengeStore.challenges = generateDailyChallenges();
        challengeStore.playerProgress = {};
    }

    res.json(challengeStore.challenges);
});

// Temp session store (use Redis in production)
const activeSessions = new Map();

// Endpoint for React to register wallet
app.post("/link-wallet", async (req, res) => {
    const { sessionToken, walletAddress, signature } = req.body;

    // Verify wallet signature here (security critical!)
    const isValid = await verifySignature(walletAddress, signature);

    if (isValid) {
        activeSessions.set(sessionToken, { walletAddress });
        res.json({ success: true });
    } else {
        res.status(401).json({ error: "Invalid signature" });
    }
});

app.post("/honeycomb-auth-confirm", async (req, res) => {
    const { walletAddress, signature } = req.body;
    console.log("signature", signature);
    // Convert signature to Base58
    const signatureBytes = Uint8Array.from(signature.split(",").map(Number));
    const base58Signature = bs58.encode(signatureBytes);

    console.log("auth confirming ", walletAddress);

    // Use your backend's honeycombClient
    const { authConfirm } = await honeycombClient.authConfirm({
        wallet: walletAddress,
        signature: base58Signature,
    });

    const accessToken = authConfirm.accessToken;

    console.log("Gotten Access token", accessToken);
    res.json({ accessToken });
});

app.get("/honeycomb-auth-request", async (req, res) => {
    const walletAddress = req.query.wallet;
    console.log("WAllet", walletAddress);
    const m = await honeycombClient.authRequest({ wallet: walletAddress });
    console.log("Got request", m);
    const message = m.authRequest.message;
    res.json({ message });
});

// Endpoint for Love2D to check session
app.get("/check-session", (req, res) => {
    console.log("[SESSION] Checking session for token:", req.query.token);
    console.log("[SESSION] Current sessions:", challengeStore.sessions);
    const session = challengeStore.sessions?.[req.query.token]; // activeSessions.get(req.query.token);
    console.log(
        (session && "session found!") || "session not found at all",
        session,
    );
    res.json(session || { error: "Not linked" });
});

app.post("/connect", async (req, res) => {
    console.log("[API] POST /connect request received:", req.body);
    const { walletAddress } = req.body;

    try {
        console.log(`[WALLET] Validating wallet: ${walletAddress}`);
        const pubkey = new PublicKey(walletAddress);
        const accountInfo = await connection.getAccountInfo(pubkey);

        if (!accountInfo) {
            console.log(`[WALLET] Wallet not found: ${walletAddress}`);
            throw new Error("Wallet not found");
        }

        console.log(`[WALLET] Wallet validated: ${walletAddress}`);
        res.json({
            wallet: walletAddress,
            challenges: challengeStore.challenges,
            progress: challengeStore.playerProgress[walletAddress] || {},
        });
    } catch (err) {
        console.error("[API] /connect error:", err);
        res.status(400).json({ error: err.message });
    }
});

// Add this near your other route handlers
app.post("/verify-session", async (req, res) => {
    console.log("[API] POST /verify-session request received:", req.body);
    const { sessionToken, walletAddress, signature, accessToken } = req.body;

    try {
        const signatureBytes = Uint8Array.from(
            signature.split(",").map(Number),
        );
        const message = `Verify wallet for game session: ${sessionToken}`;
        const verified = nacl.sign.detached.verify(
            new TextEncoder().encode(message),
            signatureBytes,
            new PublicKey(walletAddress).toBytes(),
        );
        console.log("verified??", verified);
        if (verified) {
            console.log(
                `[SESSION] Verified wallet ${walletAddress} for session ${sessionToken}`,
            );

            // Store the session (in-memory for now - use Redis in production)
            if (!challengeStore.sessions) challengeStore.sessions = {};

            console.log(req.body);

            const signatureArray = signature.split(",").map(Number);
            const signature58 = bs58.encode(Uint8Array.from(signatureArray));

            challengeStore.sessions[sessionToken] = {
                walletAddress,
                verifiedAt: new Date().toISOString(),
                signature: signature,
                accessToken: accessToken,
            };

            return res.json({
                verified: true,
                //accessToken: authConfirm.accessToken,
                // user: authConfirm.user
            });

            //return res.json({ verified: true });
        }

        throw new Error("Invalid signature");
    } catch (err) {
        console.error("[API] /verify-session error:", err);
        res.status(400).json({ error: err.message });
    }
});
/*
function verifyWalletSignature(wallet, message, signature) {
  // Implement actual signature verification
  // Example using Solana web3.js:
  const publicKey = new PublicKey(wallet);
  return nacl.sign.detached.verify(
    Buffer.from(message),
    Buffer.from(signature, 'hex'),
    publicKey.toBytes()
  );
}*/

// === Honeycomb-Specific Routes ===
app.post("/getAccessToken", async (req, res) => {
    const { wallet, project, sessionToken } = req.body;
    console.log("Getting access token", req.body);
    try {
        const data = challengeStore.sessions[sessionToken];
        if (!data) throw Error(`No session found of ${sessionToken}`);

        return res.json({
            accessToken: data.accessToken,
        });
    } catch (err) {
        console.error("Failed to get access token", err);
    }
});

// User Creation
app.post("/honeycomb-create-user", async (req, res) => {
    console.log("hmm user creation");
    const { walletAddress } = req.body;

    //needed for auth-confirm

    try {
        const { user: userr } = await honeycombClient.findUsers({
            wallets: [walletAddress], // Filter by your project
        });
        console.log("user found");
        if (userr.length > 0) {
            const tx = "";
            console.log("user already exists");
            res.json({ success: true, tx });
            return;
        }
        const {
            createNewUserWithProfileTransaction: c, // This is the transaction response, you'll need to sign and send this transaction
        } = await honeycombClient.createNewUserWithProfileTransaction({
            project: honeycombProject,
            profileIdentity: "main",
            wallet: walletAddress,
            payer: treasurerWallet.publicKey.toString(),
            userInfo: {
                name: `${crypto.randomUUID().slice(0, 4)}-${Math.random().toString(36).slice(2, 8)}`,
                bio: "a user",
                pfp: "https://lh3.googleusercontent.com/-Jsm7S8BHy4nOzrw2f5AryUgp9Fym2buUOkkxgNplGCddTkiKBXPLRytTMXBXwGcHuRr06EvJStmkHj-9JeTfmHsnT0prHg5Mhg",
            },
        });

        console.log(c);
        const result = await sendTransactionT(
            honeycombClient,
            c,
            [treasurerWallet], // Payer keypair
        );

        console.log("User creation confirmed on-chain:", result);
        console.log("usser created with wallet", walletAddress);

        const tx = c.tx;
        console.log("Fetched users wallet:", userr.length, userr);
        res.json({ success: true, tx });
    } catch (err) {
        console.error(err);
        res.status(400).json({ error: err.message });
    }
});

// Profile Management
app.post("/profiles", async (req, res) => {
    const { project, identity, info, payer } = req.body;
    const authHeader = req.headers.authorization;
    //console.log("Authorization is ",authHeader,"at",req.body);
    try {
        if (!authHeader) throw new Error("Authorization required");
        const { profile } = await honeycombClient.findProfiles({
            wallets: [payer],
            projects: [honeycombProject],
        });
        if (profile.length > 0) {
            console.log("Profile already exists");
            res.json({
                status: "done",
            });
            return;
        }

        const { createNewProfileTransaction: dat } =
            await honeycombClient.createNewProfileTransaction(
                {
                    project,
                    identity: identity || "main",
                    info: info || {},
                    payer: payer, //treasurerWallet.publicKey.toString() || project
                },
                {
                    fetchOptions: {
                        headers: { authorization: authHeader },
                    },
                },
            );

        const result = await sendTransactionT(
            honeycombClient,
            dat,
            [treasurerWallet], // Payer keypair\
        );

        console.log("profile created", dat);
        res.json({
            transaction: dat.tx,
            status: "done",
        });
    } catch (err) {
        console.error("[PROFILE] Creation failed:", err);
        res.status(400).json({ error: err.message });
    }
});

// XP and Achievements
app.post("/xp", async (req, res) => {
    const { wallet, project, amount } = req.body;
    try {
        const profile = await honeycombClient
            .findProfiles({
                wallets: [wallet],
                projects: [project],
            })
            .then(({ profile }) => profile[0]);

        if (!profile) throw new Error("Profile not found");

        console.log(`adding ${amount} xp to profile`);
        const { createUpdatePlatformDataTransaction: dat } =
            await honeycombClient.createUpdatePlatformDataTransaction({
                profile: profile.address,
                platformData: { addXp: parseInt(amount) || 0 },
                authority: treasurerWallet.publicKey.toString(),
            });

        const result = await sendTransactionT(
            honeycombClient,
            dat,
            [treasurerWallet], // Payer keypair\
        );

        const xxp = profile.platformData || 0;
        console.log(result, xxp);
        res.json({
            transaction: dat.tx,
            xp_added: amount,
        });
    } catch (err) {
        console.error("[XP] Error:", err);
        res.status(400).json({ error: err.message });
    }
});

app.post("/achievements", async (req, res) => {
    const { wallet, project, achievement } = req.body;

    try {
        const profile = await honeycombClient
            .findProfiles({
                wallets: [wallet],
                projects: [project],
            })
            .then(({ profile }) => profile[0]);

        if (!profile) throw new Error("Profile not found");

        const { tx } =
            await honeycombClient.createUpdatePlatformDataTransaction({
                profile: profile.address,
                platformData: {
                    addAchievements: [achievement],
                },
                authority: treasurerWallet.publicKey.toString(),
            });

        res.json({
            transaction: tx,
            achievement_unlocked: achievement,
        });
    } catch (err) {
        console.error("[ACHIEVEMENT] Error:", err);
        res.status(400).json({ error: err.message });
    }
});

// Custom Data Storage
app.post("/data", async (req, res) => {
    const { wallet, project, key, value, metadata, sessionToken } = req.body;

    const authHeader = req.headers.authorization;
    try {
        // 1. First verify inputs
        console.log("Searching profiles for:", {
            wallet: wallet,
            project: project,
            key: key,
            value: value,
        });
        const session = challengeStore.sessions[sessionToken];
        if (!session) {
            return res.status(401).json({ error: "Invalid session" });
        }
        // 2. Add Honeycomb query debugging
        const profileRes = await honeycombClient.findProfiles({
            wallets: [wallet],
            projects: [project],
        });
        //console.log("Raw Honeycomb response:", JSON.stringify(profileRes, null, 2));

        // 3. Validate response structure
        if (!profileRes?.profile || !Array.isArray(profileRes.profile)) {
            throw new Error(
                `Invalid profile response: ${JSON.stringify(profileRes)}`,
            );
        }

        const profile = profileRes.profile[0];
        if (!profile?.address) {
            throw new Error(
                `Profile missing address: ${JSON.stringify(profile)}`,
            );
        }

        console.log("Found profile:", profile.address);

        // 4. Debug update transaction
        const updateParams = {
            profile: profile.address,
            customData: { add: [[key, JSON.stringify(value)]] },
            payer: wallet, // treasurerWallet.publicKey.toString()
        };
        console.log("Update params:", updateParams, session.accessToken);

        const updateRes = await honeycombClient.createUpdateProfileTransaction(
            updateParams,

            {
                fetchOptions: {
                    headers: { authorization: `Bearer ${session.accessToken}` },
                },
            },
        );
        console.log("Update response:", JSON.stringify(updateRes, null, 2));

        if (!updateRes?.tx) {
            throw new Error("No transaction returned from Honeycomb");
        }

        const result = await sendTransactionT(
            honeycombClient,
            updateRes,
            [treasurerWallet], // Payer keypair\
        );

        return { tx: updateRes.tx };
    } catch (err) {
        console.error("Profile update failed:", {
            error: err.message,
            stack: err.stack,
            input: { wallet, project, key, value },
        });
        throw err; // Re-throw after logging
    }
});

app.get("/data/:key", async (req, res) => {
    const { wallet, project } = req.query;
    const { key } = req.params;

    try {
        console.log("dataa2");
        const profile = await honeycombClient
            .findProfiles({
                wallets: [wallet],
                projects: [project],
            })
            .then(({ profile }) => profile[0]);

        if (!profile) throw new Error("Profile not found");

        const value = profile.customData?.find(
            (item) => item.key === key,
        )?.value;

        res.json({
            key,
            value: value ? JSON.parse(value) : null,
        });
    } catch (err) {
        console.error("[DATA] Retrieval failed:", err);
        res.status(400).json({ error: err.message });
    }
});

// === Enhanced Existing Routes ===

app.post("/progress", async (req, res) => {
    const { walletAddress, challengeId, progress, sessionToken } = req.body;

    try {
        // Session verification
        if (sessionToken) {
            const session = challengeStore.sessions?.[sessionToken];
            if (!session || session.walletAddress !== walletAddress) {
                throw new Error("Invalid session");
            }
        }

        // Local progress tracking
        if (!challengeStore.playerProgress[walletAddress]) {
            challengeStore.playerProgress[walletAddress] = {};
        }

        const playerProgress = challengeStore.playerProgress[walletAddress][
            challengeId
        ] || {
            completed: 0,
            claimed: false,
        };

        playerProgress.completed += progress;

        // On-chain XP reward
        if (honeycombProject) {
            const { createUpdatePlatformDataTransaction: dat } =
                await honeycombClient.createUpdatePlatformDataTransaction({
                    profile: await getProfileAddress(walletAddress),
                    platformData: { addXp: Math.floor(progress * 10) }, // 10 XP per progress point
                    authority: treasurerWallet.publicKey.toString(),
                });
            const result = await sendTransactionT(
                honeycombClient,
                dat,
                [treasurerWallet], // Payer keypair\
            );
        }

        res.json({ progress: playerProgress });
    } catch (err) {
        console.error("[PROGRESS] Error:", err);
        res.status(400).json({ error: err.message });
    }
});

// === Helper Functions ===
// Add to top with other stores
const profileCache = new Map();

// Modify getProfileAddress
async function getProfileAddress(wallet) {
    if (profileCache.has(wallet)) {
        return profileCache.get(wallet);
    }

    const { profile } = await honeycombClient.findProfiles({
        wallets: [wallet],
        projects: [honeycombProject],
    });

    if (profile[0]) {
        profileCache.set(wallet, profile[0].address);
    }

    return profile[0]?.address;
}

async function ensureProjectInitialized() {
    if (!honeycombProject) {
        try {
            honeycombProject = await getExistingProject(
                process.env.PROJECT_PUBKEY,
            );
            await createProfilesTree(honeycombProject);
        } catch {
            console.log("No existing project found, creating new one");
            honeycombProject = await initializeProject();

            await createProfilesTree(honeycombProject);
            // Create profiles tree after project init
            /*const {
          createCreateProfilesTreeTransaction: txResponse // This is the transaction response, you'll need to sign and send this transaction

        } = await honeycombClient.createCreateProfilesTreeTransaction(
          {
            payer: treasurerWallet.publicKey.toString(),
            project: honeycombProject.toString(),
            treeConfig: {
              basic: { numAssets: 100000 }
            }
      });
      console.log("tree",txResponse);
      
      const txToSend = {
        ...txResponse.tx,
        feePayer: treasurerWallet.publicKey.toString() // Must include feePayer
      };
       await sendTransactionT(
      honeycombClient,
      txToSend,
      [treasurerWallet],
      //connection
    ); */
        }
    }
    return honeycombProject;
}

// Health check endpoint
app.get("/health", async (req, res) => {
    console.log("[API] Health check requested");
    try {
        const balance = await connection.getBalance(treasurerWallet.publicKey);
        const health = {
            status: "OK",
            treasurerBalance: `${balance / LAMPORTS_PER_SOL} SOL`,
            projectInitialized: !!honeycombProject,
            lastChallengeReset: challengeStore.currentDate,
            timestamp: new Date().toISOString(),
        };
        console.log("[HEALTH] System health:", health);
        res.json(health);
    } catch (err) {
        console.error("[HEALTH] Error:", err);
        res.status(500).json({ status: "ERROR", error: err.message });
    }
});

process.on("uncaughtException", (err) => {
    console.error("Uncaught Exception:", err);
});

process.on("unhandledRejection", (err) => {
    console.error("Unhandled Rejection:", err);
});

// === START SERVER ===
app.listen(PORT, async () => {
    console.log(`[SERVER] Starting initialization on port ${PORT}...`);
    console.log(`[ENV] Current environment:`, {
        NODE_ENV: process.env.NODE_ENV,
        SOLANA_RPC: process.env.SOLANA_RPC,
        HONEYCOMB_API_URL: process.env.HONEYCOMB_API_URL,
    });

    try {
        honeycombProject = await ensureProjectInitialized();
        challengeStore.challenges = generateDailyChallenges();

        console.log(`[SERVER] Ready!`);
        console.log(
            `[INFO] Treasurer: ${treasurerWallet.publicKey.toString()}`,
        );
        console.log(
            `[INFO] Project: ${honeycombProject?.toString() || "Not created"}`,
        );
        console.log(
            `[INFO] Explorer: https://explorer.solana.com/address/${treasurerWallet.publicKey.toString()}?cluster=devnet`,
        );
    } catch (err) {
        console.error("[FATAL] Failed to initialize server:", err);
        process.exit(1);
    }
});
