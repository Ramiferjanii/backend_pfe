const express = require('express');
const router = express.Router();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const auth = require('../middleware/auth');

// GET: List all notifications for user
router.get('/', auth, async (req, res) => {
    try {
        const { limit = 10, page = 1 } = req.query;
        const pLimit = parseInt(limit);
        const pPage = parseInt(page);
        const skip = (pPage - 1) * pLimit;

        const notifications = await prisma.notification.findMany({
            where: { userId: req.user.id },
            orderBy: { createdAt: 'desc' },
            take: pLimit,
            skip: skip
        });
        
        const unreadCount = await prisma.notification.count({
            where: { userId: req.user.id, isRead: false }
        });

        res.json({
            notifications,
            unreadCount
        });
    } catch (error) {
        console.error('Error fetching notifications:', error);
        res.status(500).json({ error: 'Server Error', details: error.message });
    }
});

// PUT: Mark notification as read
router.put('/:id/read', auth, async (req, res) => {
    try {
        const notificationId = req.params.id;
        
        const notification = await prisma.notification.findUnique({
            where: { id: notificationId }
        });

        if (!notification || notification.userId !== req.user.id) {
            return res.status(404).json({ error: 'Notification not found' });
        }

        const updated = await prisma.notification.update({
            where: { id: notificationId },
            data: { isRead: true }
        });

        res.json({ message: 'Marked as read', notification: updated });
    } catch (error) {
        console.error('Error updating notification:', error);
        res.status(500).json({ error: 'Server Error', details: error.message });
    }
});

// PUT: Mark all as read
router.put('/read-all', auth, async (req, res) => {
    try {
        await prisma.notification.updateMany({
            where: { userId: req.user.id, isRead: false },
            data: { isRead: true }
        });

        res.json({ message: 'All notifications marked as read' });
    } catch (error) {
        console.error('Error updating notifications:', error);
        res.status(500).json({ error: 'Server Error', details: error.message });
    }
});

module.exports = router;
