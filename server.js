import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import RunwayML from "@runwayml/sdk";
import ffmpegPath from "ffmpeg-static";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { execFile } from "child_process";
import { promisify } from "util";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

const API_KEY = process.env.RUNWAYML_API_SECRET;
const SCENE_COUNT = Number(process.env.SCENE_COUNT || 2);
const CLIP_DURATION = 5;

const OUTPUT_DIR = path.join(process.cwd(), "output");
const TEMP_DIR = path.join(process.cwd(), "temp");

fs.mkdirSync(OUTPUT_DIR, { recursive: true });
fs.mkdirSync(TEMP_DIR, { recursive: true });

/* =========================
   CORS
========================= */

app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type"]
  })
);

app.use(express.json({ limit: "1mb" }));

app.use("/output", express.static(OUTPUT_DIR));

const jobs = new Map();

let client = null;

if (API_KEY) {
  client = new RunwayML({
    apiSecret: API_KEY
  });
}

/* =========================
   HOME
========================= */

app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "VEOX AI Backend is running 🚀"
  });
});

/* =========================
   HEALTH
========================= */

app.get("/api/health", (req, res) => {
  res.json({
    success: true,
    runwayConfigured: Boolean(API_KEY),
    sceneCount: SCENE_COUNT,
    clipDuration: CLIP_DURATION,
    targetDuration: SCENE_COUNT * CLIP_DURATION
  });
});

/* =========================
   CREATE PROMPTS
========================= */

function createScenePrompts(story) {
  const sentences = story
    .split(/[.!?]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const prompts = [];

  for (let i = 0; i < SCENE_COUNT; i++) {
    const part =
      sentences[i % Math.max(sentences.length, 1)] ||
      story;

    prompts.push(
      `Cinematic AI video scene based on this story moment: ${part}. ` +
      `Create a beautiful coherent scene with natural movement, ` +
      `cinematic camera motion, detailed environment, realistic lighting, ` +
      `high quality film look and consistent visual storytelling. ` +
      `Do not add text, subtitles, logos or watermarks.`
    );
  }

  return prompts;
}

/* =========================
   DOWNLOAD VIDEO
========================= */

async function downloadVideo(url, filePath) {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(
      `Failed to download generated video: ${response.status}`
    );
  }

  const buffer = Buffer.from(
    await response.arrayBuffer()
  );

  await fs.promises.writeFile(
    filePath,
    buffer
  );
}

/* =========================
   GENERATE ONE CLIP
========================= */

async function generateClip(
  prompt,
  ratio,
  filePath
) {
  if (!client) {
    throw new Error(
      "RUNWAYML_API_SECRET is missing in Render Environment Variables."
    );
  }

  console.log("Starting Runway generation...");

  const taskRequest =
    client.imageToVideo.create({
      model: "gen4.5",
      promptText: prompt,
      ratio: ratio,
      duration: CLIP_DURATION
    });

  console.log("Waiting for Runway task...");

  const completedTask =
    await taskRequest.waitForTaskOutput({
      timeout: 15 * 60 * 1000
    });

  const videoUrl =
    completedTask?.output?.[0];

  if (!videoUrl) {
    console.error(
      "Runway response:",
      completedTask
    );

    throw new Error(
      "Runway completed the task but returned no video."
    );
  }

  await downloadVideo(
    videoUrl,
    filePath
  );

  console.log("Video clip downloaded.");

  return filePath;
}

/* =========================
   FFMPEG
========================= */

const execFileAsync =
  promisify(execFile);

/* =========================
   MERGE VIDEOS
========================= */

async function mergeVideos(
  videoFiles,
  outputFile
) {
  const listFile = path.join(
    TEMP_DIR,
    `list-${crypto.randomUUID()}.txt`
  );

  const content = videoFiles
    .map((file) => {
      const safePath =
        path
          .resolve(file)
          .replace(/'/g, "'\\''");

      return `file '${safePath}'`;
    })
    .join("\n");

  await fs.promises.writeFile(
    listFile,
    content,
    "utf8"
  );

  await execFileAsync(
    ffmpegPath,
    [
      "-y",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      listFile,
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      "-an",
      outputFile
    ],
    {
      maxBuffer: 10 * 1024 * 1024
    }
  );

  await fs.promises
    .unlink(listFile)
    .catch(() => {});

  return outputFile;
}

/* =========================
   GENERATE FULL VIDEO
========================= */

async function generateFullVideo(
  jobId,
  story,
  ratio
) {
  const job = jobs.get(jobId);

  if (!job) {
    return;
  }

  const prompts =
    createScenePrompts(story);

  const videoFiles = [];

  try {
    for (
      let i = 0;
      i < prompts.length;
      i++
    ) {
      job.status = "generating";

      job.progress = Math.round(
        (i / prompts.length) * 85
      );

      job.message =
        `Generating scene ${i + 1} of ${prompts.length}...`;

      const clipPath = path.join(
        TEMP_DIR,
        `${jobId}-scene-${i + 1}.mp4`
      );

      await generateClip(
        prompts[i],
        ratio,
        clipPath
      );

      videoFiles.push(clipPath);

      job.progress = Math.round(
        ((i + 1) / prompts.length) * 85
      );
    }

    /* MERGE */

    job.status = "merging";
    job.progress = 90;
    job.message =
      "Combining your scenes...";

    const outputName =
      `veox-${jobId}.mp4`;

    const outputPath =
      path.join(
        OUTPUT_DIR,
        outputName
      );

    await mergeVideos(
      videoFiles,
      outputPath
    );

    /* COMPLETE */

    job.status = "completed";
    job.progress = 100;
    job.message =
      "Your AI video is ready! 🎉";

    job.videoUrl =
      `/output/${outputName}`;

    /* DELETE TEMP FILES */

    for (const file of videoFiles) {
      await fs.promises
        .unlink(file)
        .catch(() => {});
    }

    console.log(
      `Job ${jobId} completed successfully.`
    );

  } catch (error) {
    console.error(
      "VIDEO GENERATION ERROR:",
      error
    );

    job.status = "failed";
    job.progress = 0;

    job.error =
      error?.message ||
      "Video generation failed.";

    job.message =
      "Video generation failed.";

    for (const file of videoFiles) {
      await fs.promises
        .unlink(file)
        .catch(() => {});
    }
  }
}

/* =========================
   GENERATE API
========================= */

app.post(
  "/api/generate",
  async (req, res) => {
    try {
      console.log(
        "POST /api/generate received"
      );

      const {
        story,
        ratio = "1280:720"
      } = req.body;

      if (
        !story ||
        !story.trim()
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Please provide a story."
        });
      }

      if (!API_KEY) {
        return res.status(500).json({
          success: false,
          message:
            "Runway API key is not configured."
        });
      }

      const allowedRatios = [
        "1280:720",
        "720:1280"
      ];

      if (
        !allowedRatios.includes(ratio)
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Invalid video ratio."
        });
      }

      const jobId =
        crypto.randomUUID();

      jobs.set(jobId, {
        id: jobId,
        status: "starting",
        progress: 0,
        message:
          "Starting AI video generation...",
        videoUrl: null,
        error: null,
        createdAt: Date.now()
      });

      res.status(202).json({
        success: true,
        jobId,
        message:
          "Video generation started."
      });

      generateFullVideo(
        jobId,
        story.trim(),
        ratio
      );

    } catch (error) {
      console.error(
        "GENERATE ERROR:",
        error
      );

      res.status(500).json({
        success: false,
        message:
          error?.message ||
          "Could not start video generation."
      });
    }
  }
);

/* =========================
   STATUS
========================= */

app.get(
  "/api/status/:jobId",
  (req, res) => {
    const job =
      jobs.get(req.params.jobId);

    if (!job) {
      return res.status(404).json({
        success: false,
        message:
          "Job not found."
      });
    }

    res.json({
      success: true,
      job
    });
  }
);

/* =========================
   404
========================= */

app.use(
  (req, res) => {
    res.status(404).json({
      success: false,
      message:
        "VEOX AI endpoint not found."
    });
  }
);

/* =========================
   SERVER
========================= */

app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `VEOX AI running on port ${PORT}`
    );

    console.log(
      `Runway configured: ${Boolean(API_KEY)}`
    );

    console.log(
      `Scenes: ${SCENE_COUNT}`
    );

    console.log(
      `Clip duration: ${CLIP_DURATION}s`
    );
  }
);
