const jwt = require("jsonwebtoken");
const { prisma } = require("../../prisma/prismaClient");

const userAuth = async (req, res, next) => {
  try {
    const token = req.cookies.auth_token;
    if (!token) {
      throw new Error("You are Unauthorised , Plss Login...");
    }

    // verify token
    const decodedObj = await jwt.verify(token, process.env.JWT_SECRET_KEY);

    const { userId } = decodedObj;

    // finding user in db
    const user = await prisma.users.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new Error("user not found");
    }
    req.user = user;
    next();
  } catch (err) {
    res.status(401).json({ message: "Error:", error: err.message });
  }
};



const RequestValidation = (req , fromUserId) => {

  const { toUserId, status } = req.params;
  
  if (fromUserId === toUserId) {
    throw new Error("You can send request to Youself");
  }

  const allowedStatus = ["interested", "ignored"];
  if (!allowedStatus.includes(status)) {
    throw new Error("Invalid status value");
  }

};


const ReviewValidation = (req)=>{
    const {status} = req.params
    const allowedStatus = ['accepted' , 'rejected']
    if(!allowedStatus.includes(status)){
        throw new Error("invalid status value")
    }
}
module.exports = { userAuth, RequestValidation  , ReviewValidation};
