import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import os from "os";
import { execFile } from "child_process";
import RunwayML, { TaskFailedError } from "@runwayml/sdk";

const app = express();

app.use(cors());
app.use(express.json({ limit: "20mb" }));

const PORT = process.env.PORT || 10000;
const RUNWAY_API_KEY = process.env.RUNWAYML_API_SECRET;

if (!RUNWAY_API_KEY) {
  console.error("ERROR: RUNWAYML_API_SECRET is missing");
}

if (RUNWAY_API_KEY && !RUNWAY_API_KEY.startsWith("key_")) {
  console.error("ERROR: Runway API key must start with key_");
}

const runway = new RunwayML({
  apiKey: RUNWAY_API_KEY
});

app.get("/", (req, res) => {
  res.json({
    status: "online",
    service: "VEOX AI",
    videoLength: "10 minutes"
  });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    runwayConfigured:
      !!RUNWAY_API_KEY &&
      RUNWAY_API_KEY.startsWith("key_")
  });
});

/*
  Generate ONE short clip.
  The same character reference image is used
  for every scene.
*/
async function generateClip({
  prompt,
  characterImage,
  duration = 10,
  ratio = "1280:720"
}) {
  const input = {
    model: "gen4.5",
    promptText: prompt,
    ratio,
    duration
  };

  if (characterImage) {
    input.promptImage = characterImage;
  }

  console.log("Generating clip...");

  const task = await runway.imageToVideo
    .create(input)
    .waitForTaskOutput({
      timeout: 10 * 60 * 1000
    });

  if (!task.output || !task.output[0]) {
    throw new Error("Runway did not return a video URL");
  }

  return task.output[0];
}

/*
  Download generated video.
*/
async function downloadVideo(url, filename) {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(
      `Video download failed: ${response.status}`
    );
  }

  const buffer = Buffer.from(await response.arrayBuffer());

  fs.writeFileSync(filename, buffer);

  return filename;
}

/*
  Join all clips using FFmpeg.
*/
function mergeVideos(files, output) {
  return new Promise((resolve, reject) => {
    const listFile = path.join(
      os.tmpdir(),
      `veox-${Date.now()}.txt`
    );

    const content = files
      .map(file => `file '${file.replace(/'/g, "'\\''")}'`)
      .join("\n");

    fs.writeFileSync(listFile, content);

    execFile(
      "ffmpeg",
      [
        "-y",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        listFile,
        "-c",
        "copy",
        output
      ],
      (error, stdout, stderr) => {
        fs.unlinkSync(listFile);

        if (error) {
          console.error(stderr);
          reject(error);
          return;
        }

        resolve(output);
      }
    );
  });
}

/*
  10-minute video generator

  10 minutes = 600 seconds.

  With 10-second clips:
  600 / 10 = 60 clips.
*/
app.post("/api/generate-10min", async (req, res) => {
  try {
    const {
      prompt,
      characterImage,
      ratio = "1280:720"
    } = req.body;

    if (!prompt) {
      return res.status(400).json({
        error: "prompt is required"
      });
    }

    if (!RUNWAY_API_KEY) {
      return res.status(500).json({
        error: "RUNWAYML_API_SECRET is missing on Render"
      });
    }

    if (!RUNWAY_API_KEY.startsWith("key_")) {
      return res.status(500).json({
        error:
          "Invalid Runway API key format. It must start with key_"
      });
    }

    const clips = [];

    const totalClips = 60;

    console.log(
      `Starting 10-minute generation: ${totalClips} clips`
    );

    for (let i = 0; i < totalClips; i++) {
      console.log(
        `Generating clip ${i + 1}/${totalClips}`
      );

      /*
        Important:
        The SAME characterImage is sent
        to every generation.
      */

      const scenePrompt = `
Maintain the exact same main character throughout the video.

Character consistency:
- same face
- same hairstyle
- same clothing
- same body proportions
- same overall appearance
- same visual style

Scene ${i + 1} of ${totalClips}.

${prompt}

Keep the character visually consistent with
the provided reference image.
Do not redesign or replace the character.
`;

      const videoUrl = await generateClip({
        prompt: scenePrompt,
        characterImage,
        duration: 10,
        ratio
      });

      const filename = path.join(
        os.tmpdir(),
        `veox-clip-${Date.now()}-${i}.mp4`
      );

      await downloadVideo(videoUrl, filename);

      clips.push(filename);

      console.log(
        `Clip ${i + 1}/${totalClips} completed`
      );
    }

    console.log("All clips generated.");
    console.log("Merging clips...");

    const finalFile = path.join(
      os.tmpdir(),
      `veox-final-${Date.now()}.mp4`
    );

    await mergeVideos(clips, finalFile);

    console.log("Final 10-minute video created.");

    res.json({
      success: true,
      duration: "10 minutes",
      clips: clips.length,
      video: `/api/video/${path.basename(finalFile)}`
    });

  } catch (error) {
    console.error("Generation error:", error);

    if (error instanceof TaskFailedError) {
      return res.status(500).json({
        error: "Runway generation failed"
      });
    }

    res.status(500).json({
      error: error.message || "Video generation failed"
    });
  }
});

/*
  Serve generated videos.
*/
app.get("/api/video/:filename", (req, res) => {
  const filename = path.basename(req.params.filename);
  const filepath = path.join(os.tmpdir(), filename);

  if (!fs.existsSync(filepath)) {
    return res.status(404).json({
      error: "Video not found"
    });
  }

  res.sendFile(filepath);
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`VEOX AI running on port ${PORT}`);

  console.log(
    "Runway configured:",
    !!RUNWAY_API_KEY &&
    RUNWAY_API_KEY.startsWith("key_")
  );
});
