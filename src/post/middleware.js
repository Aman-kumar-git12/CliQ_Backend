const ValidatePost = (req) => {
    const { content, image } = req.body;

    if (!content && !image) {
        throw new Error("Content or image is required")
    }
    if (content && content.length > 50) {
        throw new Error("Content length should be less than 50")
    }
}

const ValidatePostUpdate = (req) => {
    const { content } = req.body;
    if (!content) {
        throw new Error("Content is required")
    }
    if (content && content.length > 50) {
        throw new Error("Content length should be less than 50")
    }
}

const ValidatePostDelete = (req) => {
    const { postId } = req.params;
    if (!postId) {
        throw new Error("Id is required")
    }  
}



module.exports = { ValidatePost , ValidatePostUpdate , ValidatePostDelete }   