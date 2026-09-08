import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import RunwayML, { TaskFailedError } from "@runwayml/sdk";
import ffmpegPath from "ffmpeg-static";
import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import { execFile } from "child_process";
import { promisify } from "util";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json({ limit: "1mb" }));

const API_KEY = process.env.RUNWAYML_API_SECRET;

const SCENE_COUNT = Number(process.env.SCENE_COUNT || 120);
const CLIP_DURATION = 5;

const client = API_KEY
  ? new RunwayML({
      apiSecret: API_KEY
    })
  : null;

const jobs = new Map();

const execFileAsync = promisify(execFile);

/*
  HOME
*/
app.get("/", (req, res) => {
  res.json({
    status: "online",
    service: "VEOX AI",
    videoLength: "10 minutes"
  });
});

/*
  HEALTH CHECK
*/
app.get("/api/health", (req, res) => {
  res.json({
    success: true,
    status: "online",
    service: "VEOX AI",
    runwayConfigured: Boolean(API_KEY),
    sceneCount: SCENE_COUNT,
    clipDuration: CLIP_DURATION
  });
});

/*
  CREATE SCENE PROMPTS
*/
function createScenePrompts(story) {
  const sentences = story
    .split(/[.!?]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const prompts = [];

  for (let i = 0; i < SCENE_COUNT; i++) {
    const part =
      sentences[i % Math.max(sentences.length, 1)] || story;

    prompts.push(
      `Cinematic AI video scene based on this story moment: ${part}. ` +
      `Beautiful coherent visual storytelling, natural movement, ` +
      `cinematic camera motion, detailed environment, realistic lighting, ` +
      `high quality film look. Do not add text, subtitles, logos or watermarks.`
    );
  }

  return prompts;
}

/*
  DOWNLOAD VIDEO
*/
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

  await fs.promises.writeFile(filePath, buffer);
}

/*
  GENERATE ONE CLIP
*/
async function generateClip(prompt, ratio, filePath) {
  if (!client) {
    throw new Error(
      "RUNWAYML_API_SECRET is missing in Render Environment Variables."
    );
  }

  const task = client.imageToVideo.create({
    model: "gen4.5",
    promptText: prompt,
    ratio: ratio,
    duration: CLIP_DURATION
  });

  const completedTask =
    await task.waitForTaskOutput({
      timeout: 15 * 60 * 1000
    });

  const videoUrl =
    completedTask?.output?.[0];

  if (!videoUrl) {
    throw new Error(
      "Runway completed the task but returned no video."
    );
  }

  await downloadVideo(
    videoUrl,
    filePath
  );

  return filePath;
}

/*
  MERGE VIDEOS
*/
async function mergeVideos(
  videoFiles,
  outputFile
) {
  const listFile = path.join(
    os.tmpdir(),
    `veox-list-${crypto.randomUUID()}.txt`
  );

  const content = videoFiles
    .map(
      (file) =>
        `file '${path.resolve(file)}'`
    )
    .join("\n");

  await fs.promises.writeFile(
    listFile,
    content,
    "utf8"
  );

  try {
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
      ]
    );
  } finally {
    await fs.promises
      .unlink(listFile)
      .catch(() => {});
  }
}

/*
  GENERATE VIDEO
*/
app.post("/api/generate", async (req, res) => {
  try {
    const {
      story,
      ratio = "1280:720"
    } = req.body;

    if (!story || !story.trim()) {
      return res.status(400).json({
        success: false,
        message: "Please provide a story."
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

    if (!allowedRatios.includes(ratio)) {
      return res.status(400).json({
        success: false,
        message: "Invalid video ratio."
      });
    }

    const jobId = crypto.randomUUID();

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
      "Generate request error:",
      error
    );

    res.status(500).json({
      success: false,
      message:
        error?.message ||
        "Could not start video generation."
    });
  }
});

/*
  FULL VIDEO GENERATION
*/
async function generateFullVideo(
  jobId,
  story,
  ratio
) {
  const job = jobs.get(jobId);

  if (!job) return;

  const prompts =
    createScenePrompts(story);

  const clips = [];

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

      console.log(
        `Generating scene ${i + 1}/${prompts.length}`
      );

      const clipFile = path.join(
        os.tmpdir(),
        `veox-${jobId}-scene-${i + 1}.mp4`
      );

      await generateClip(
        prompts[i],
        ratio,
        clipFile
      );

      clips.push(clipFile);

      job.progress = Math.round(
        ((i + 1) / prompts.length) * 85
      );
    }

    console.log(
      "All clips generated."
    );

    job.status = "merging";
    job.progress = 90;
    job.message =
      "Combining your scenes...";

    console.log(
      "Merging clips..."
    );

    const finalFile = path.join(
      os.tmpdir(),
      `veox-final-${jobId}.mp4`
    );

    await mergeVideos(
      clips,
      finalFile
    );

    console.log(
      "Final 10-minute video created."
    );

    job.status = "completed";
    job.progress = 100;
    job.message =
      "Your AI video is ready! 🎉";

    job.videoUrl =
      `/api/video/${path.basename(finalFile)}`;

    for (const clip of clips) {
      await fs.promises
        .unlink(clip)
        .catch(() => {});
    }

  } catch (error) {
    console.error(
      "Generation error:",
      error
    );

    job.status = "failed";
    job.progress = 0;

    if (error instanceof TaskFailedError) {
      job.error =
        "Runway generation failed.";
    } else {
      job.error =
        error?.message ||
        "Video generation failed.";
    }

    for (const clip of clips) {
      await fs.promises
        .unlink(clip)
        .catch(() => {});
    }
  }
}

/*
  VIDEO FILE
*/
app.get(
  "/api/video/:filename",
  (req, res) => {
    const filename =
      path.basename(
        req.params.filename
      );

    const filepath =
      path.join(
        os.tmpdir(),
        filename
      );

    if (!fs.existsSync(filepath)) {
      return res.status(404).json({
        error: "Video not found"
      });
    }

    res.sendFile(filepath);
  }
);

/*
  JOB STATUS
*/
app.get(
  "/api/status/:jobId",
  (req, res) => {
    const job =
      jobs.get(
        req.params.jobId
      );

    if (!job) {
      return res.status(404).json({
        success: false,
        message: "Job not found."
      });
    }

    res.json({
      success: true,
      job
    });
  }
);

/*
  404
*/
app.use(
  (req, res) => {
    res.status(404).json({
      success: false,
      message:
        "VEOX AI endpoint not found.",
      path: req.originalUrl
    });
  }
);

/*
  START SERVER
*/
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
  }
);
