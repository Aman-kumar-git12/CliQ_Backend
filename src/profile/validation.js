
const ValidationFields = (req) => {
  const allowedEditsFields = [
    "firstname",
    "lastname",
    "email",
    "age",
    "password"
  ];
  const isEditAllowed = Object.keys(req.body).every((field) =>
    allowedEditsFields.includes(field)
  );
  return isEditAllowed;
};
module.exports = {ValidationFields}