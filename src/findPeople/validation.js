    
    
    
    
const SearchValidation = (req , user) => {

    if (!user) {
      throw new Error("User not found");
    }

    if (user.id === req.user.id) {
      throw new Error("This is You");
    }
}
module.exports = { SearchValidation };