import express from 'express';

const router = express.Router();

router.get('/upgrade/payfast', (req, res) => {
  const { partnerId, plan, amount, email, companyName, contactName } = req.query;

  res.send(`
    <h1>🚀 Redirecting to PayFast...</h1>
    <p><strong>Partner ID:</strong> ${partnerId}</p>
    <p><strong>Plan:</strong> ${plan}</p>
    <p><strong>Amount:</strong> R${amount}</p>
    <p><strong>Email:</strong> ${email}</p>
    <p><strong>Company:</strong> ${companyName}</p>
    <p><strong>Contact:</strong> ${contactName}</p>
    <p>This simulates PayFast's payment page for development purposes.</p>
  `);
});

export default router;
