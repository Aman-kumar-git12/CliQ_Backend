const Validator = require('validator');

const ValidationSignupData = (req) => {
    const {firstname , lastname , email , password} = req.body
    if (!firstname || !lastname){
        throw new Error("Firstname and Lastname are required")
    }
    else if (!Validator.isEmail(email)){
        throw new Error("Invalid email format")
    }
    else if (!Validator.isStrongPassword(password)){
        throw new Error("Password should be strong")
    }

}


const ValidationFields = (req) => {
  const allowedEditsFields = [
    "firstName",
    "lastName",
    "email",
    "gender",
    "age",
    "password"
  ];
  const isEditAllowed = Object.keys(req.body).every((field) =>
    allowedEditsFields.includes(field)
  );
  return isEditAllowed;
};

module.exports = {ValidationSignupData , ValidationFields}