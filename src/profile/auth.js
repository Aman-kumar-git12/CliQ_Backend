const express = require("express")
const jwt  = require('jsonwebtoken')
const {prisma} = require('../../prisma/prismaClient')

const userAuth = async (req , res , next) => {
    try{
        const token = req.cookies.auth_token
        if (!token){
            throw new Error("You are Unauthorised , Plss Login...")
        }

        // verify token
        const decodedObj  = await jwt.verify(token, process.env.JWT_SECRET_KEY )

        const {userId} = decodedObj
        // finding user in db 
        const user = await prisma.users.findUnique({
            where : {id : userId}

        })
        if (!user){
            throw new Error ("user not found")
        }
        req.user = user
        next()
    }catch(err){
        res.status(401).json({message : "Error:" , error : err.message})
    }                           
}
module.exports = {userAuth}