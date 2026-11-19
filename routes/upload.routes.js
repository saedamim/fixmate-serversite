
import express from "express";
import multer from "multer";

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024,
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith("image/")) {
      cb(null, true);
    } else {
      cb(new Error("Only image files are allowed"));
    }
  },
});

router.post("/image", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) {
      console.error("Upload rejected: no file received. Content-Type:", req.headers["content-type"]);
      return res.status(400).json({
        message: "Please select an image",
      });
    }

    const formData = new FormData();

    formData.append("image", req.file.buffer.toString("base64"));
console.log("API key exists:", Boolean(process.env.IMGBB_API_KEY));
console.log("API key length:", process.env.IMGBB_API_KEY?.trim().length);
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
