const { signup } = require("./signupController");
const { login, getMe, logout } = require("./loginController");
const { verifyEmail, resendVerificationEmail, verifyOTP } = require("./verifyController");
const { forgotPassword, resetPassword } = require("./passwordController");
const { createUnblockRequest } = require("./unblockController");

module.exports = {
    signup,
    login,
    getMe,
    logout,
    verifyEmail,
    resendVerificationEmail,
    verifyOTP,
    forgotPassword,
    resetPassword,
    createUnblockRequest
};
