const safeUserSelect = {
    id: true,
    firstname: true,
    lastname: true,
    email: true,
    age: true,
    authProvider: true,
    emailVerified: true,
    role: true,
    isBlocked: true,
    imageUrl: true,
    createdAt: true,
    updatedAt: true,
};

const publicUserSelect = {
    id: true,
    firstname: true,
    lastname: true,
    age: true,
    imageUrl: true,
    expertise: true,
    email: true,
    createdAt: true,
    updatedAt: true,
};

// For bulk listings (search, suggestions): no email, so results can't be
// used to harvest addresses. Single-profile views still use publicUserSelect.
const { email: _email, ...listUserSelect } = publicUserSelect;

const toSafeUser = (user) => {
    if (!user) return null;

    return {
        id: user.id,
        firstname: user.firstname,
        lastname: user.lastname,
        email: user.email,
        age: user.age,
        authProvider: user.authProvider,
        emailVerified: user.emailVerified,
        role: user.role,
        isBlocked: user.isBlocked,
        imageUrl: user.imageUrl,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
    };
};

const toPublicUser = (user) => {
    if (!user) return null;

    return {
        id: user.id,
        firstname: user.firstname,
        lastname: user.lastname,
        age: user.age,
        imageUrl: user.imageUrl,
        expertise: user.expertise,
        email: user.email,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
    };
};

const toListUser = (user) => {
    if (!user) return null;

    const { email: _email, ...listUser } = toPublicUser(user);
    return listUser;
};

module.exports = {
    safeUserSelect,
    publicUserSelect,
    listUserSelect,
    toSafeUser,
    toPublicUser,
    toListUser,
};
