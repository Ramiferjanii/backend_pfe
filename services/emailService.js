const nodemailer = require('nodemailer');
const { Parser } = require('json2csv');

const transporter = nodemailer.createTransport({
  service: 'gmail', // easiest for testing, can be changed to SMTP
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

/**
 * Sends an email notification when scraping is complete.
 * @param {string} toEmail - Recipient email address
 * @param {string} websiteUrl - The URL that was scraped
 * @param {Array<Object> | number} items - Items array or count of items
 */
async function sendScrapingNotification(toEmail, websiteUrl, items) {
  if (!toEmail) {
    console.warn("No email address provided for notification.");
    return;
  }

  const isArray = Array.isArray(items);
  const itemCount = isArray ? items.length : items;

  // If credentials are not set, log a warning but don't crash
  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
      console.warn("⚠️ EMAIL_USER or EMAIL_PASS missing in .env. Email notification simplified to console log.");
      console.log(`[EMAIL SIMULATION] To: ${toEmail}, Subject: Scraping Completed, Body: Found ${itemCount} items from ${websiteUrl}`);
      return;
  }

  const mailOptions = {
    from: process.env.EMAIL_USER,
    to: toEmail,
    subject: `Scraping Completed: ${itemCount} items found`,
    html: `
      <div style="font-family: Arial, sans-serif; padding: 20px;">
        <h2 style="color: #4F46E5;">Scraping Task Finished</h2>
        <p>Your scraping task for <strong>${websiteUrl}</strong> has completed successfully.</p>
        <p><strong>${itemCount}</strong> items were found and saved to your database.</p>
        <br/>
        <a href="http://localhost:3000/dashboard" style="background-color: #4F46E5; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">View Dashboard</a>
      </div>
    `,
    attachments: []
  };

  // Generate CSV Attachment if items data is provided
  if (isArray && items.length > 0) {
      try {
          const fields = ['name', 'price', 'reference', 'category', 'url', 'image'];
          const json2csvParser = new Parser({ fields });
          const csv = json2csvParser.parse(items);
          
          mailOptions.attachments.push({
              filename: 'scraping_results.csv',
              content: csv,
              contentType: 'text/csv'
          });
      } catch (err) {
          console.error('Failed to generate CSV attachment for email:', err);
      }
  }

  try {
    await transporter.sendMail(mailOptions);
    console.log(`Email notification sent to ${toEmail}`);
  } catch (error) {
    console.error('Error sending email notification:', error);
  }
}

module.exports = { sendScrapingNotification };
