const express  = require('express')
const app = express()
const {prisma} = require('../prisma/prismaClient')
const {authUserRoutes} = require('./auth/auth')
const {ProfileRoute} = require('./profile/profile')
const cookieParser = require('cookie-parser')



app.use(cookieParser())
app.use(express.json())




app.use('/' , authUserRoutes)
app.use('/' , ProfileRoute)


// checking server
app.get('/users' , async (req,res)=>{
    const users = await prisma.user.findMany()
    res.json(users)
})


app.listen(2000 , (err)=>{
    console.log('Server is running on port 2000')
})

