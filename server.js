const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
dotenv.config();
const http = require("http");
const { Server } = require("socket.io");
const fs = require("fs");
const bodyParser = require("body-parser");
const { default: axios } = require("axios");
const { PutObjectCommand, S3Client } = require("@aws-sdk/client-s3");
const { default: OpenAI } = require("openai");
const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 5000;

app.use(bodyParser.json());
app.use(cors());
app.use(express.json());

const BucketRegion = process.env.AWS_BUCKET_REGION;
const BucketAccessKeyId = process.env.AWS_ACCESS_KEY_ID;
const BucketSecretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
const Bucket = process.env.AWS_BUCKET_NAME;

const s3 = new S3Client({
  region: BucketRegion,
  credentials: {
    accessKeyId: BucketAccessKeyId,
    secretAccessKey: BucketSecretAccessKey,
  },
});

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_SECRET_KEY,
});

const allowedOrigins = process.env.ELECTRON_HOST?.split(",") || [];
const io = new Server(server, {
  cors: {
    origin: allowedOrigins.length > 0 ? allowedOrigins : "*",
    methods: ["GET", "POST"],
  },
});

const recordedChunks = {};

io.on("connection", (socket) => {
  console.log("🟢 Socket is connected");

  socket.on("video-chunks", async (data) => {
    console.log("🟢 Video chunks received");
    const filePath = `temp_upload/${data.filename}`;

    if (!recordedChunks[data.filename]) {
      recordedChunks[data.filename] = [];
    }
    recordedChunks[data.filename].push(data.chunks);

    fs.appendFile(filePath, data.chunks, (err) => {
      if (err) {
        console.error("🔴 Error saving video chunk:", err);
      }
    });
  });

  socket.on("process-video", async (data) => {
    console.log("🟢 Processing video...");

    const filePath = `temp_upload/${data.filename}`;

    fs.readFile(filePath, async (err, file) => {
      if (err) {
        console.error("🔴 Error reading video file:", err);
        return;
      }

      const processing = await axios.post(
        `${process.env.NEXT_API_HOST}recording/${data.userId}/processing`,
        { filename: data.filename }
      );

      if (processing.status !== 200) {
        console.log("🔴 Error processing video");
        return;
      }

      const command = new PutObjectCommand({
        Bucket,
        Key: data.filename,
        Body: file,
        ContentType: "video/webm",
      });

      const fileStatus = await s3.send(command);

      if (fileStatus["$metadata"].httpStatusCode === 200) {
        console.log("🟢 Video uploaded to AWS -> S3");

        if (processing.data.plan === "PRO") {
          fs.stat(filePath, async (err, stat) => {
            if (err) {
              console.log("🔴 Error getting file stats", err);
              return;
            }
            if (stat.size < 25000000) {
              console.log("🟢 Transcribing video...");

              const transcription = await openai.audio.transcriptions.create({
                file: fs.createReadStream(filePath),
                model: "whisper-1",
                response_format: "text",
              });

              if (transcription) {
                console.log("🟢 Transcription received", transcription);
                const completion = await openai.chat.completions.create({
                  model: "gpt-3.5-turbo",
                  response_format: { type: "json_object" },
                  messages: [
                    {
                      role: "system",
                      content: `You are going to generate a title and a nice description using the speech to text transcription provided: transcription: ${transcription}
                      and then return it in JSON format as {"title": <title>, "summary": <summary>}`,
                    },
                  ],
                });

                console.log(
                  "🟢 Completion received",
                  completion.choices[0].message.content
                );

                const titleAndSummaryGenerated = await axios.post(
                  `${process.env.NEXT_API_HOST}recording/${data.userId}/transcribe`,
                  {
                    filename: data.filename,
                    content: completion.choices[0].message.content,
                    transcript: transcription,
                  }
                );

                if (titleAndSummaryGenerated.status !== 200) {
                  console.log("🔴 Error generating title and summary");
                } else {
                  console.log("🟢 Title and summary generated");
                }
              }
            } else {
              console.log("🔴 File size is too large");
            }
          });
        }

        const stopProcessing = await axios.post(
          `${process.env.NEXT_API_HOST}recording/${data.userId}/complete`,
          { filename: data.filename }
        );

        if (stopProcessing.status === 200) {
          fs.unlink(filePath, (err) => {
            if (err) console.log("🔴 Error deleting file", err);
            else console.log(`${data.filename} 🟢 File deleted`);
          });
        } else {
          console.log("🔴 Error stopping processing");
        }
      } else {
        console.log("🔴 Error uploading video to AWS -> S3");
      }
    });
  });

  socket.on("disconnect", () => {
    console.log("🔴 Socket is disconnected", socket.id);
  });
});

server.listen(PORT, () => {
  console.log(`🟢 Server is running on port ${PORT}`);
});
