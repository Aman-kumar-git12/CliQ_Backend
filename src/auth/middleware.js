const Validator = require('validator');

const ValidationSignupData = (req) => {
    const {firstname , lastname , email , password , age } = req.body
    if (!firstname || !lastname){
        throw new Error("Firstname and Lastname are required")
    }
    else if (!email){
        throw new Error("Email is required")
    }
    else if (!Validator.isEmail(email)){
        throw new Error("Invalid email format")
    }
    else if (!password){
        throw new Error ("Password is required")
    }
    else if (!Validator.isStrongPassword(password)){
        throw new Error("Password should be strong")
    }
    else if (!age){
        throw new Error("Age is required")
    }
    else if (age <13){
        throw new Error("Age must be at least 13 years")
    }

}



module.exports = {ValidationSignupData}