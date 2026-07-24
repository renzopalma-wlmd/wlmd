const { WebClient } = require('@slack/web-api');
const config = require('./src/config');

async function testAuth() {
  try {
    const web = new WebClient(config.slack.botToken);
    const res = await web.auth.test();
    console.log('✅ Auth successful!');
    console.log(`Bot User ID: ${res.user_id}`);
    console.log(`Bot Name: ${res.user}`);
    console.log(`Team ID: ${res.team_id}`);
    console.log(`Team Name: ${res.team}`);
  } catch (error) {
    console.error('❌ Auth failed:', error.message);
  }
}

testAuth();
