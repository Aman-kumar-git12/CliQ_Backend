const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {

    await prisma.users.create({
        data: {
            firstname: "Aman",
            lastname: "Kumar",
            email: "aman@example.com",
            age: 21,
            password: "hashedpassword",
            posts: {
                create: [
                    {
                        content: "Hello world!",
                        image: "https://example.com/image.png"
                    },
                    {
                        content: "My second post",
                        image: "https://example.com/image.png"
                    }
                ]
            }
        }
    });

    console.log("Seeding completed!");
}

main()
    .catch((e) => {
        console.error(e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
