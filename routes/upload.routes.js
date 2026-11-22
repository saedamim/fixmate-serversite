
import express from "express";
import multer from "multer";

const router = express.Router();

// This route is used before an account exists (avatar on sign up), so it is open to everyone. It therefore:
//  - accepts only PNG, JPEG, WebP and GIF, checked by the real file bytes and not just the claimed type
//  - limits each IP address to a few uploads per window, so nobody can burn the ImgBB quota
const ALLOWED_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
const looksLikeImage = (b) =>
  (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) || // PNG
  (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) || // JPEG
  (b.subarray(0, 4).toString("ascii") === "RIFF" && b.subarray(8, 12).toString("ascii") === "WEBP") || // WebP
  b.subarray(0, 4).toString("ascii") === "GIF8"; // GIF

const WINDOW_MS = 10 * 60 * 1000;
const MAX_UPLOADS_PER_WINDOW = 10;
const hits = new Map();
const rateLimit = (req, res, next) => {
  const now = Date.now();
  const entry = hits.get(req.ip);
  if (!entry || entry.resetAt <= now) {
    hits.set(req.ip, { count: 1, resetAt: now + WINDOW_MS });
    if (hits.size > 5000) for (const [ip, e] of hits) if (e.resetAt <= now) hits.delete(ip);
    return next();
  }
  if (entry.count >= MAX_UPLOADS_PER_WINDOW) {
    return res.status(429).json({ message: "Too many uploads. Please try again in a few minutes." });
  }
  entry.count += 1;
  next();
};

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 2 * 1024 * 1024,
  },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_TYPES.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Only PNG, JPEG, WebP or GIF images are allowed"));
    }
  },
});

// Turns multer errors (wrong type, too large) into a clean 400 instead of a 500
const single = (req, res, next) =>
  upload.single("image")(req, res, (error) => {
    if (!error) return next();
    const message = error.code === "LIMIT_FILE_SIZE" ? "Image must be 2 MB or smaller" : error.message;
    res.status(400).json({ message });
  });

router.post("/image", rateLimit, single, async (req, res) => {
  try {
    if (!req.file) {
      console.error("Upload rejected: no file received. Content-Type:", req.headers["content-type"]);
      return res.status(400).json({
        message: "Please select an image",
      });
    }

    if (!looksLikeImage(req.file.buffer)) {
      return res.status(400).json({ message: "That file is not a valid image" });
    }

    const formData = new FormData();

    formData.append("image", req.file.buffer.toString("base64"));
    const response = await fetch(
      `https://api.imgbb.com/1/upload?key=${process.env.IMGBB_API_KEY}`,
      {
        method: "POST",
        body: formData,
      }
    );

    const result = await response.json();

    if (!response.ok || !result.success) {
      // Log ImgBB's real error (never the request URL, which contains the API key)
      console.error("ImgBB upload failed:", {
        httpStatus: response.status,
        imgbbError: result?.error || result,
        apiKeyConfigured: Boolean(process.env.IMGBB_API_KEY),
      });

      return res.status(400).json({
        message: result?.error?.message || "Image upload failed",
      });
    }

    res.status(200).json({
      message: "Image uploaded successfully",
      imageUrl: result.data.url,
    });
  } catch (error) {
    console.error("Image upload error:", error);

    res.status(500).json({
      message: "Image upload failed",
    });
  }
});

export default router;
