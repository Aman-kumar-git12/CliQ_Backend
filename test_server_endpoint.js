const crypto = require('crypto');

const BASE_URL = 'http://localhost:2003';

async function test() {
    try {
        const email = `test_${crypto.randomBytes(4).toString('hex')}@example.com`;
        console.log("1. Signing up with", email);

        const signupRes = await fetch(`${BASE_URL}/signup`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                firstname: "Test",
                lastname: "User",
                email: email,
                age: 25,
                password: "Test@123456"
            })
        });

        if (!signupRes.ok) {
            const text = await signupRes.text();
            throw new Error(`Signup failed: ${signupRes.status} ${text}`);
        }

        // Extract cookie
        const cookie = signupRes.headers.get('set-cookie');
        if (!cookie) console.log("Warning: No cookie in header? content:", signupRes.headers);
        else console.log("   Signup successful. Cookie:", cookie);

        console.log("2. Testing POST /post/feed/random ...");
        const feedRes = await fetch(`${BASE_URL}/post/feed/random`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Cookie': cookie || ""
            },
            body: JSON.stringify({ excludeIds: [] })
        });

        if (!feedRes.ok) {
            console.error("   Failed! Status:", feedRes.status);
            const text = await feedRes.text();
            console.error("   Response:", text);
        } else {
            console.log("   Success!");
            const data = await feedRes.json();
            console.log("   Data:", JSON.stringify(data, null, 2).substring(0, 500));
        }

    } catch (error) {
        console.error("Global Error:", error);
    }
}

test();
