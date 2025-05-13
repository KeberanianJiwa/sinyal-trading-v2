// File: api/ping.js
export default function handler(request, response) {
  response.status(200).json({ message: 'pong', timestamp: new Date().toISOString() });
}