import { ObjectId } from "mongodb";
import { db } from "../config/db.js";

const ID_PATTERN = /^[a-f\d]{24}$/i;

// verifyToken proves WHO the caller is. The role is then read from the database on every request, not from the
// token, so a demoted or deleted account loses access immediately instead of when its (15 minute) token expires.
// req.user.role is replaced with the database role, so everything after this middleware sees the current one.
const verifyRole = (...allowedRoles) => {
  return async (req, res, next) => {
    try {
      const id = String(req.user?.id ?? "");
      const user = ID_PATTERN.test(id)
        ? await db.collection("user").findOne({ _id: new ObjectId(id) }, { projection: { role: 1 } })
        : null;

      if (!user || !allowedRoles.includes(user.role)) {
        return res.status(403).json({
          success: false,
          message: "Access forbidden",
        });
      }

      req.user.role = user.role;
      next();
    } catch (error) {
      next(error); // a database failure answers with the JSON 500 handler in index.js (never grants access)
    }
  };
};

export default verifyRole;
