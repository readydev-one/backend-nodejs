// models/Post.js
const mongoose = require('mongoose');

const postSchema = new mongoose.Schema({
  content: {
    type: String,
    required: true,
    maxLength: 280 // Twitter-like limit
  },
  user: {
    id: { type: mongoose.Schema.Types.ObjectId, required: true },
    username: { type: String, required: true },
    displayName: { type: String, required: true },
    avatar: { type: String, default: null }
  },
  likes: {
    count: { type: Number, default: 0 },
    userIds: [{ type: mongoose.Schema.Types.ObjectId }] // For tracking who liked
  },
  createdAt: {
    type: Date,
    default: Date.now,
    index: -1 // Index for sorting
  },
  isDeleted: {
    type: Boolean,
    default: false
  }
}, {
  timestamps: true
});

// Compound index for efficient cursor-based pagination
postSchema.index({ createdAt: -1, _id: -1 });

module.exports = mongoose.model('Post', postSchema);

// server.js
const express = require('express');
const mongoose = require('mongoose');
const crypto = require('crypto');
const Post = require('./models/Post');

const app = express();
const PORT = 3000;

app.use(express.json());

// Connect to MongoDB
mongoose.connect('mongodb://localhost:27017/social_media_demo', {
  useNewUrlParser: true,
  useUnifiedTopology: true,
});

// Utility functions for cursor encoding/decoding
const encodeCursor = (createdAt, id) => {
  const cursor = `${createdAt.toISOString()}|${id}`;
  return Buffer.from(cursor).toString('base64');
};

const decodeCursor = (cursor) => {
  try {
    const decoded = Buffer.from(cursor, 'base64').toString('utf-8');
    const [createdAt, id] = decoded.split('|');
    
    if (!createdAt || !id) {
      throw new Error('Invalid cursor format');
    }
    
    const date = new Date(createdAt);
    if (isNaN(date.getTime())) {
      throw new Error('Invalid date in cursor');
    }
    
    if (!mongoose.Types.ObjectId.isValid(id)) {
      throw new Error('Invalid ObjectId in cursor');
    }
    
    return { createdAt: date, id };
  } catch (error) {
    throw new Error('Malformed cursor');
  }
};

// Main pagination route
app.get('/api/posts', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 10, 50); // Max 50 posts per request
    const cursor = req.query.after;
    
    let query = { isDeleted: false }; // Exclude deleted posts
    
    // Handle cursor for pagination
    if (cursor) {
      try {
        const { createdAt, id } = decodeCursor(cursor);
        
        // Use compound cursor for precise pagination
        query.$or = [
          { createdAt: { $lt: createdAt } },
          { 
            createdAt: createdAt,
            _id: { $lt: new mongoose.Types.ObjectId(id) }
          }
        ];
      } catch (error) {
        return res.status(400).json({
          error: 'Invalid cursor',
          message: error.message
        });
      }
    }
    
    // Fetch posts with one extra to check for next page
    const posts = await Post.find(query)
      .sort({ createdAt: -1, _id: -1 }) // Compound sort for consistency
      .limit(limit + 1)
      .lean(); // Use lean() for better performance
    
    // Check if there are more posts
    const hasMore = posts.length > limit;
    const slicedPosts = hasMore ? posts.slice(0, -1) : posts;
    
    // Generate next cursor
    let nextCursor = null;
    if (hasMore && slicedPosts.length > 0) {
      const lastPost = slicedPosts[slicedPosts.length - 1];
      nextCursor = encodeCursor(lastPost.createdAt, lastPost._id);
    }
    
    // Transform posts for response (remove sensitive data)
    const transformedPosts = slicedPosts.map(post => ({
      id: post._id,
      content: post.content,
      user: {
        id: post.user.id,
        username: post.user.username,
        displayName: post.user.displayName,
        avatar: post.user.avatar
      },
      likes: {
        count: post.likes.count
        // Don't expose userIds for privacy
      },
      createdAt: post.createdAt
    }));
    
    res.json({
      posts: transformedPosts,
      pagination: {
        nextCursor,
        hasMore,
        limit,
        count: transformedPosts.length
      }
    });
    
  } catch (error) {
    console.error('Pagination error:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to fetch posts'
    });
  }
});

// Route to create a new post (for testing)
app.post('/api/posts', async (req, res) => {
  try {
    const { content, userId, username, displayName, avatar } = req.body;
    
    if (!content || !userId || !username || !displayName) {
      return res.status(400).json({
        error: 'Missing required fields',
        required: ['content', 'userId', 'username', 'displayName']
      });
    }
    
    const post = new Post({
      content,
      user: {
        id: userId,
        username,
        displayName,
        avatar
      }
    });
    
    await post.save();
    
    res.status(201).json({
      id: post._id,
      content: post.content,
      user: post.user,
      likes: post.likes,
      createdAt: post.createdAt
    });
    
  } catch (error) {
    console.error('Create post error:', error);
    res.status(500).json({
      error: 'Failed to create post'
    });
  }
});

// Route to like a post
app.post('/api/posts/:postId/like', async (req, res) => {
  try {
    const { postId } = req.params;
    const { userId } = req.body;
    
    if (!userId) {
      return res.status(400).json({ error: 'userId is required' });
    }
    
    const post = await Post.findById(postId);
    if (!post || post.isDeleted) {
      return res.status(404).json({ error: 'Post not found' });
    }
    
    const userObjectId = new mongoose.Types.ObjectId(userId);
    const hasLiked = post.likes.userIds.some(id => id.equals(userObjectId));
    
    if (hasLiked) {
      // Unlike
      post.likes.userIds = post.likes.userIds.filter(id => !id.equals(userObjectId));
      post.likes.count = Math.max(0, post.likes.count - 1);
    } else {
      // Like
      post.likes.userIds.push(userObjectId);
      post.likes.count += 1;
    }
    
    await post.save();
    
    res.json({
      liked: !hasLiked,
      likesCount: post.likes.count
    });
    
  } catch (error) {
    console.error('Like post error:', error);
    res.status(500).json({ error: 'Failed to update like' });
  }
});

// Route to soft delete a post
app.delete('/api/posts/:postId', async (req, res) => {
  try {
    const { postId } = req.params;
    const { userId } = req.body; // In real app, get from auth token
    
    const post = await Post.findById(postId);
    if (!post || post.isDeleted) {
      return res.status(404).json({ error: 'Post not found' });
    }
    
    // Check if user owns the post (simplified check)
    if (!post.user.id.equals(new mongoose.Types.ObjectId(userId))) {
      return res.status(403).json({ error: 'Not authorized to delete this post' });
    }
    
    post.isDeleted = true;
    await post.save();
    
    res.json({ message: 'Post deleted successfully' });
    
  } catch (error) {
    console.error('Delete post error:', error);
    res.status(500).json({ error: 'Failed to delete post' });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({
    error: 'Internal server error',
    message: 'Something went wrong'
  });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({
    error: 'Not found',
    message: 'The requested resource was not found'
  });
});

app.listen(PORT, () => {
  console.log(`Social Media API running on http://localhost:${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log(`Posts endpoint: http://localhost:${PORT}/api/posts`);
});

module.exports = app;