const jwt = require("jsonwebtoken");
const { config } = require("../../config");

const safeUserSelect = {
    id: true,
    firstname: true,
    lastname: true,
    email: true,
    age: true,
    authProvider: true,
    emailVerified: true,
    role: true,
    isBlocked: true,
    imageUrl: true,
    createdAt: true,
    updatedAt: true,
};

const publicUserSelect = {
    id: true,
    firstname: true,
    lastname: true,
    age: true,
    imageUrl: true,
    expertise: true,
    email: true,
    createdAt: true,
    updatedAt: true,
};

// For bulk listings (search, suggestions): no email, so results can't be
// used to harvest addresses. Single-profile views still use publicUserSelect.
const { email: _email, ...listUserSelect } = publicUserSelect;

// Tokens issued before tokenVersion existed have no "tv" and count as version 0
const isTokenCurrent = (decodedToken, user) => (decodedToken.tv ?? 0) === (user.tokenVersion ?? 0);

// Checks an access token against the current secret, then the previous one while it is being rotated.
// An expired token gets code TOKEN_EXPIRED, which tells the browser to renew it through POST /auth/refresh.
const verifyAuthToken = (token) => {
    const secrets = [config.jwtSecret, config.jwtPreviousSecret].filter(Boolean);
    let lastError;
    for (const secret of secrets) {
        try {
            return jwt.verify(token, secret);
        } catch (err) {
            lastError = err;
            if (err.name === "TokenExpiredError") break;
        }
    }
    const error = new Error(
        lastError?.name === "TokenExpiredError" ? "Your session needs renewing." : "Invalid session. Please log in.",
    );
    error.status = 401;
    if (lastError?.name === "TokenExpiredError") error.code = "TOKEN_EXPIRED";
    throw error;
};

// Fields that must never leave the server, even inside a full user record
const SECRET_USER_FIELDS = ["password", "tokenVersion", "googleId", "blockedReason"];

const withoutSecrets = (user) => {
    if (!user) return user;
    const copy = { ...user };
    for (const field of SECRET_USER_FIELDS) delete copy[field];
    return copy;
};

const toSafeUser = (user) => {
    if (!user) return null;

    return {
        id: user.id,
        firstname: user.firstname,
        lastname: user.lastname,
        email: user.email,
        age: user.age,
        authProvider: user.authProvider,
        emailVerified: user.emailVerified,
        role: user.role,
        isBlocked: user.isBlocked,
        imageUrl: user.imageUrl,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
    };
};

const toPublicUser = (user) => {
    if (!user) return null;

    return {
        id: user.id,
        firstname: user.firstname,
        lastname: user.lastname,
        age: user.age,
        imageUrl: user.imageUrl,
        expertise: user.expertise,
        email: user.email,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
    };
};

const toListUser = (user) => {
    if (!user) return null;

    const { email: _email, ...listUser } = toPublicUser(user);
    return listUser;
};

module.exports = {
    safeUserSelect,
    publicUserSelect,
    listUserSelect,
    toSafeUser,
    toPublicUser,
    toListUser,
    withoutSecrets,
    isTokenCurrent,
    verifyAuthToken,
};
