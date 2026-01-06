/**
 * Script to link competitor products to Nutribiotics products
 *
 * Usage: node scripts/link-competitors.js
 */

const { MongoClient, ObjectId } = require('mongodb');
require('dotenv').config();

async function linkCompetitors() {
  const client = new MongoClient(process.env.MONGODB_URI);

  try {
    await client.connect();
    console.log('Connected to MongoDB');

    const db = client.db('nutribiotics');
    const productsCollection = db.collection('products');
    const brandsCollection = db.collection('brands');

    // Find Nutribiotics brand
    const nutribioticsBrand = await brandsCollection.findOne({
      name: { $regex: /^nutribiotics$/i }
    });

    if (!nutribioticsBrand) {
      console.log('⚠️  Nutribiotics brand not found!');
      console.log('Please create the Nutribiotics brand first.');
      return;
    }

    console.log('✓ Found Nutribiotics brand:', nutribioticsBrand.name);

    // Find all Nutribiotics products
    const nutriProducts = await productsCollection.find({
      brand: nutribioticsBrand._id
    }).toArray();

    console.log(`\n✓ Found ${nutriProducts.length} Nutribiotics products:`);
    nutriProducts.forEach((p, i) => {
      console.log(`  ${i + 1}. ${p.name} (${p._id})`);
    });

    // Find all competitor products (products not from Nutribiotics brand)
    const competitorProducts = await productsCollection.find({
      brand: { $ne: nutribioticsBrand._id }
    }).toArray();

    console.log(`\n✓ Found ${competitorProducts.length} competitor products:`);
    competitorProducts.forEach((p, i) => {
      console.log(`  ${i + 1}. ${p.name} (Brand: ${p.brand}, comparedTo: ${p.comparedTo || 'none'})`);
    });

    // Example: Link MULTIVIT to MULTIESSENS VITAMINAS
    console.log('\n--- Linking competitors ---');

    // Find by name (you can customize this logic)
    const multiessens = nutriProducts.find(p => p.name.includes('MULTIESSENS'));
    const multivit = competitorProducts.find(p => p.name.includes('MULTIVIT'));

    if (multiessens && multivit) {
      console.log(`\nLinking "${multivit.name}" to "${multiessens.name}"...`);

      const result = await productsCollection.updateOne(
        { _id: multivit._id },
        { $set: { comparedTo: multiessens._id } }
      );

      console.log(`✓ Updated ${result.modifiedCount} product(s)`);

      // Verify
      const updated = await productsCollection.findOne({ _id: multivit._id });
      console.log(`✓ Verified: ${updated.name} now compares to ${updated.comparedTo}`);
    } else {
      console.log('\n⚠️  Could not find MULTIESSENS or MULTIVIT products to link');
      console.log('You may need to manually link products or adjust the search logic');
    }

    console.log('\n✅ Done! Run the price comparison job again to see recommendations.');

  } catch (error) {
    console.error('Error:', error);
  } finally {
    await client.close();
  }
}

linkCompetitors();
