const express = require('express')
const postRoute = express.Router()
const { userAuth } = require('../userConnection/auth')
const { prisma } = require("../../prisma/prismaClient");
const { ValidatePost, ValidatePostUpdate, ValidatePostDelete } = require('./middleware')



postRoute.get('/user/post', userAuth, async (req, res) => {
    try {
        const posts = await prisma.post.findMany()
        res.json(posts)
    } catch (error) {
        console.log(error)
        res.status(500).json({ message: "Internal Server Error", error: error.message })
    }
})


postRoute.get('/user/post/:userId', userAuth, async (req, res) => {
    try {
        const { userId } = req.params;
        const posts = await prisma.post.findMany({
            where: {
                userId
            }
        })
        res.json(posts)
    } catch (error) {
        console.log(error)
        res.status(500).json({ message: "Internal Server Error", error: error.message })
    }
})


postRoute.post('/user/post/comments/:postId', userAuth, async (req, res) => {
    try {
        const { postId } = req.params;
        const { comment } = req.body;
        const { id } = req.user;
        console.log(req.body)
        const newComment = await prisma.comment.create({
            data: {
                userId: id,
                postId,
                comment
            }
        })
        res.json(newComment)
    } catch (error) {
        console.log(error)
        res.status(500).json({ message: "Internal Server Error", error: error.message })
    }
})



postRoute.get('/user/post/comments/:postId', userAuth, async (req, res) => {
    try {
        const { postId } = req.params;
        const comments = await prisma.comment.findMany({
            where: {
                postId
            }
        })
        res.json(comments)
    } catch (error) {
        console.log(error)
        res.status(500).json({ message: "Internal Server Error", error: error.message })
    }
})

postRoute.post('/create/post', userAuth, async (req, res) => {
    try {
        const { content, image } = req.body;
        const { id } = req.user;
        console.log(req.body)



        ValidatePost(req)
        const post = await prisma.post.create({
            data: {
                userId: id,
                content,
                image
            }
        })


        res.json({
            message: "Post created successfully",
            post
        })
    } catch (error) {
        console.log(error)
        res.status(500).json({ message: "Internal Server Error", error: error.message })
    }
})

postRoute.delete('/delete/post/:id', userAuth, async (req, res) => {
    try {
        const { id } = req.params;
        ValidatePostDelete(req)

        const post = await prisma.post.findUnique({
            where: {
                id
            }
        })

        if (!post) {
            return res.status(404).json({ message: "Post not found" })
        }

        const deletedPost = await prisma.post.delete({
            where: {
                id
            }
        })

        res.json({
            message: "Post deleted successfully",
            deletedPost
        })
    } catch (error) {
        console.log(error)
        res.status(500).json({ message: "Internal Server Error", error: error.message })
    }
})

postRoute.patch('/update/post/:id', userAuth, async (req, res) => {
    try {
        const { id } = req.params;
        ValidatePostUpdate(req)

        const post = await prisma.post.findUnique({
            where: {
                id
            }
        })

        if (!post) {
            return res.status(404).json({ message: "Post not found" })
        }

        // only content will change
        const updatedPost = await prisma.post.update({
            where: {
                id
            },
            data: {
                content: req.body.content
            }
        })

        res.json({
            message: "Post updated successfully",
            updatedPost
        })
    } catch (error) {
        console.log(error)
        res.status(500).json({ message: "Internal Server Error", error: error.message })
    }
})

postRoute.get('/post/feed', userAuth, async (req, res) => {
    try {
        const { id } = req.user;

        const page = Number(req.query.page) || 1;
        const limit = Number(req.query.limit) || 10;
        const skip = (page - 1) * limit;

        // Step 1: fetch 50 posts randomly to avoid same order
        let posts = await prisma.post.findMany({
            where: {
                userId: { not: id }
            },
            take: 50,
            orderBy: { createdAt: "desc" }
        });

        // Step 2: Shuffle your 50 posts (your logic)
        for (let i = posts.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [posts[i], posts[j]] = [posts[j], posts[i]];
        }

        // Step 3: Apply pagination
        const paginatedPosts = posts.slice(skip, skip + limit);

        res.json({
            page,
            limit,
            hasMore: paginatedPosts.length === limit,
            posts: paginatedPosts
        });

    } catch (error) {
        console.log(error);
        res.status(500).json({ message: "Internal Server Error", error: error.message });
    }
});










module.exports = { postRoute }
