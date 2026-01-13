const express = require('express')
const postRoute = express.Router()
const { userAuth } = require('../auth/middleware')
const { prisma } = require("../../prisma/prismaClient");
const { ValidatePost, ValidatePostUpdate, ValidatePostDelete } = require('./middleware')
const cloudinary = require('../upload/cloudinary');
const upload = require('../upload/upload');


// all the posts of users 
postRoute.get('/user/post', userAuth, async (req, res) => {
    try {

        const posts = await prisma.post.findMany()
        console.log(posts)
        res.json(posts)
    } catch (error) {
        console.log(error)
        res.status(500).json({ message: "Internal Server Error", error: error.message })
    }
})


// posts by userId
postRoute.get('/user/posts/:userId', userAuth, async (req, res) => {
    try {
        const { userId } = req.params;

        const posts = await prisma.post.findMany({
            where: {
                userId: userId,   // filter posts for this user
            },
            orderBy: {
                createdAt: 'desc',
            }
        });

        res.json(posts);

    } catch (error) {
        console.log(error);
        res.status(500).json({ message: "Internal Server Error", error: error.message });
    }
});


// post by postId 
postRoute.get('/user/post/:postId', userAuth, async (req, res) => {
    try {
        const { postId } = req.params;
        console.log(postId)
        const posts = await prisma.post.findUnique({
            where: {
                id: postId
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


// just create Post 
postRoute.post("/create/post", userAuth, upload.single("image"), async (req, res) => {
    try {
        const { content } = req.body;

        let imageUrl = null;

        // If user uploaded image, upload to Cloudinary
        // If user uploaded image, upload to Cloudinary
        if (req.file) {
            const uploadPromise = new Promise((resolve, reject) => {
                const stream = cloudinary.uploader.upload_stream(
                    { folder: "posts" },
                    (error, result) => {
                        if (error) reject(error);
                        else resolve(result);
                    }
                );
                stream.end(req.file.buffer);
            });

            const result = await uploadPromise;
            imageUrl = result.secure_url;
        }

        const post = await prisma.post.create({
            data: {
                content,
                image: imageUrl,
                userId: req.user.id,
            },
        });

        res.json(post);
    } catch (error) {
        console.log(error);
        res.status(500).json({ message: "Internal Server Error" });
    }
});

// delete post by post id 
postRoute.delete('/delete/post/:postId', userAuth, async (req, res) => {
    try {
        const { postId } = req.params;
        ValidatePostDelete(req)

        const post = await prisma.post.findUnique({
            where: {
                id: postId
            }
        })

        if (!post) {
            return res.status(404).json({ message: "Post not found" })
        }

        // Ownership check
        if (post.userId !== req.user.id) {
            return res.status(403).json({ message: "You are not authorized to delete this post" })
        }

        const deletedPost = await prisma.post.delete({
            where: {
                id: postId
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


// update post by postid
postRoute.put('/update/post/:postId', userAuth, async (req, res) => {
    try {
        const { postId } = req.params;
        console.log(postId)
        ValidatePostUpdate(req)

        const post = await prisma.post.findUnique({
            where: {
                id: postId
            }
        })

        if (!post) {
            return res.status(404).json({ message: "Post not found" })
        }

        // Ownership check
        if (post.userId !== req.user.id) {
            return res.status(403).json({ message: "You are not authorized to update this post" })
        }

        // only content will change
        const updatedPost = await prisma.post.update({
            where: {
                id: postId
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

        // Fetch posts from others with stable ordering
        const posts = await prisma.post.findMany({
            where: {
                userId: { not: id }
            },
            skip: skip,
            take: limit,
            orderBy: { createdAt: "desc" }
        });

        const totalCount = await prisma.post.count({
            where: {
                userId: { not: id }
            }
        });

        res.json({
            page,
            limit,
            hasMore: skip + posts.length < totalCount,
            posts: posts
        });

    } catch (error) {
        console.log(error);
        res.status(500).json({ message: "Internal Server Error", error: error.message });
    }
});














module.exports = { postRoute }
