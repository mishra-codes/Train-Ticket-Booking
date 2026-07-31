const path = require('path');
const crypto = require('crypto');
const express = require('express');
const oracledb = require('oracledb');

const app = express();
app.use(express.json());
// Serve HTML/CSS/JS files from current directory
app.use(express.static(path.join(__dirname, 'public')));

// =========================================================
// Oracle connection pool
// =========================================================
let pool;

async function initPool() {
  pool = await oracledb.createPool({
    user: process.env.DB_USER || 'railadmin',
    password: process.env.DB_PASSWORD || 'Rail123456',
    connectString: process.env.DB_DSN || 'localhost:1521/XEPDB1',
    poolMin: 1,
    poolMax: 5,
    poolIncrement: 1,
  });
  console.log('Oracle connection pool created.');
}

async function getConn() {
  return pool.getConnection();
}

// =========================================================
// Helpers
// =========================================================
const hashPassword = password =>
  crypto.createHash('sha256').update(password).digest('hex');

// =========================================================
// AUTH — Sign Up
// =========================================================
app.post('/api/signup', async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password)
    return res.status(400).json({ message: 'Name, email, and password are required.' });
  if (password.length < 6)
    return res.status(400).json({ message: 'Password must contain at least 6 characters.' });

  const conn = await getConn();
  try {
    await conn.execute(
      `INSERT INTO rr_users (name, email, password_hash)
       VALUES (:1, :2, :3)`,
      [name.trim(), email.trim().toLowerCase(), hashPassword(password)],
      { autoCommit: true }
    );
    res.status(201).json({ message: 'Account created. You can now log in.' });
  } catch (err) {
    if (err.errorNum === 1)  // ORA-00001: unique constraint (email already exists)
      return res.status(409).json({ message: 'This email is already registered.' });
    res.status(500).json({ message: err.message });
  } finally {
    await conn.close();
  }
});

// =========================================================
// AUTH — Sign In
// =========================================================
app.post('/api/signin', async (req, res) => {
  const { email, password } = req.body;
  const conn = await getConn();
  try {
    const result = await conn.execute(
      `SELECT name, email FROM rr_users
       WHERE email = :1 AND password_hash = :2`,
      [String(email || '').trim().toLowerCase(), hashPassword(String(password || ''))],
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    if (!result.rows.length)
      return res.status(401).json({ message: 'Invalid email or password.' });
    const user = result.rows[0];
    res.json({ name: user.NAME, email: user.EMAIL });
  } finally {
    await conn.close();
  }
});

// =========================================================
// GET /api/services — list all scheduled services
// =========================================================
app.get('/api/services', async (req, res) => {
  const conn = await getConn();
  try {
    // Get all scheduled services
    const services = await conn.execute(
      `SELECT ts.service_id, tr.train_number, tr.train_name,
              tr.source_station, tr.destination_station, tr.distance_km,
              tr.departure_time, tr.arrival_time,
              TO_CHAR(ts.journey_date,'YYYY-MM-DD') AS journey_date,
              ts.service_status
       FROM train_service ts
       JOIN train tr ON tr.train_id = ts.train_id
       WHERE ts.service_status = 'SCHEDULED'
       ORDER BY ts.journey_date`,
      [],
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    // Get class inventory for each service
    const inventory = await conn.execute(
      `SELECT ci.service_id, ci.travel_class, ci.total_seats, ci.available_seats
       FROM class_inventory ci
       JOIN train_service ts ON ts.service_id = ci.service_id
       WHERE ts.service_status = 'SCHEDULED'
       ORDER BY ci.service_id`,
      [],
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    // Merge classes into each service
    const result = services.rows.map(s => ({
      service_id: s.SERVICE_ID,
      train_number: s.TRAIN_NUMBER,
      train_name: s.TRAIN_NAME,
      source_station: s.SOURCE_STATION,
      destination_station: s.DESTINATION_STATION,
      distance_km: s.DISTANCE_KM,
      departure_time: s.DEPARTURE_TIME,
      arrival_time: s.ARRIVAL_TIME,
      journey_date: s.JOURNEY_DATE,
      classes: inventory.rows
        .filter(c => c.SERVICE_ID === s.SERVICE_ID)
        .map(c => ({
          travel_class: c.TRAVEL_CLASS,
          total_seats: c.TOTAL_SEATS,
          available_seats: c.AVAILABLE_SEATS,
        })),
    }));

    res.json(result);
  } finally {
    await conn.close();
  }
});

// =========================================================
// POST /api/passengers — register a passenger
// =========================================================
app.post('/api/passengers', async (req, res) => {
  const { full_name, phone, email, id_type, id_number, date_of_birth, gender } = req.body;
  if (![full_name, phone, id_type, id_number].every(Boolean))
    return res.status(400).json({ message: 'Name, phone and identification details are required.' });

  const conn = await getConn();
  try {
    const idVar = await conn.execute(
      `INSERT INTO passenger (full_name, phone, email, id_type, id_number, date_of_birth, gender)
       VALUES (:1, :2, :3, :4, :5, TO_DATE(:6,'YYYY-MM-DD'), :7)
       RETURNING passenger_id INTO :8`,
      [
        full_name, phone, email || null, id_type, id_number,
        date_of_birth || null, gender ? gender.toUpperCase() : null,
        { type: oracledb.NUMBER, dir: oracledb.BIND_OUT }
      ],
      { autoCommit: true }
    );
    const passengerId = idVar.outBinds[0][0];
    res.status(201).json({ message: 'Passenger registered successfully.', passengerId });
  } catch (err) {
    if (err.errorNum === 1)
      return res.status(409).json({ message: 'A passenger with this phone or ID already exists.' });
    res.status(500).json({ message: err.message });
  } finally {
    await conn.close();
  }
});

// =========================================================
// GET /api/fare — calculate fare preview
// =========================================================
app.get('/api/fare', async (req, res) => {
  const conn = await getConn();
  try {
    const result = await conn.execute(
      `SELECT calculate_fare(:1, :2) AS fare, tr.distance_km
       FROM train_service ts JOIN train tr ON tr.train_id = ts.train_id
       WHERE ts.service_id = :1`,
      [Number(req.query.service_id), String(req.query.travel_class || '').toUpperCase()],
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    if (!result.rows.length)
      return res.status(400).json({ message: 'Choose a valid train service and class.' });
    res.json({ fare: result.rows[0].FARE, distance_km: result.rows[0].DISTANCE_KM });
  } catch (err) {
    res.status(400).json({ message: err.message });
  } finally {
    await conn.close();
  }
});

// =========================================================
// POST /api/bookings — book a ticket (calls book_ticket proc)
// =========================================================
app.post('/api/bookings', async (req, res) => {
  const conn = await getConn();
  try {
    const result = await conn.execute(
      `BEGIN book_ticket(:passenger_id, :service_id, :travel_class, :pnr, :status, :fare); END;`,
      {
        passenger_id: Number(req.body.passenger_id),
        service_id: Number(req.body.service_id),
        travel_class: String(req.body.travel_class || '').toUpperCase(),
        pnr: { type: oracledb.STRING, dir: oracledb.BIND_OUT, maxSize: 20 },
        status: { type: oracledb.STRING, dir: oracledb.BIND_OUT, maxSize: 20 },
        fare: { type: oracledb.NUMBER, dir: oracledb.BIND_OUT },
      }
    );
    const { pnr, status, fare } = result.outBinds;

    // Get seat/waitlist info
    const ticketRow = await conn.execute(
      `SELECT seat_number, waitlist_number FROM ticket WHERE pnr = :1`,
      [pnr],
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    const t = ticketRow.rows[0];
    res.status(201).json({
      pnr,
      booking_status: status,
      fare,
      seat_number: t.SEAT_NUMBER || null,
      waitlist_number: t.WAITLIST_NUMBER || null,
    });
  } catch (err) {
    if (err.errorNum === 20001 || err.errorNum === 20002)
      return res.status(400).json({ message: err.message });
    if (String(err.message).includes('not found') || err.errorNum === 1403)
      return res.status(404).json({ message: 'Passenger ID was not found. Register the passenger first.' });
    res.status(500).json({ message: err.message });
  } finally {
    await conn.close();
  }
});

// =========================================================
// GET /api/tickets/:pnr — PNR status lookup
// =========================================================
app.get('/api/tickets/:pnr', async (req, res) => {
  const conn = await getConn();
  try {
    const result = await conn.execute(
      `SELECT t.pnr, t.booking_status, t.seat_number, t.waitlist_number,
              t.fare, p.full_name, tr.train_name, tr.train_number,
              tr.source_station, tr.destination_station,
              TO_CHAR(ts.journey_date,'YYYY-MM-DD') AS journey_date,
              t.travel_class
       FROM ticket t
       JOIN passenger p ON p.passenger_id = t.passenger_id
       JOIN train_service ts ON ts.service_id = t.service_id
       JOIN train tr ON tr.train_id = ts.train_id
       WHERE t.pnr = :1`,
      [req.params.pnr.toUpperCase()],
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    if (!result.rows.length)
      return res.status(404).json({ message: 'No ticket found for this PNR.' });
    const r = result.rows[0];
    res.json({
      pnr: r.PNR, booking_status: r.BOOKING_STATUS,
      seat_number: r.SEAT_NUMBER, waitlist_number: r.WAITLIST_NUMBER,
      fare: r.FARE, full_name: r.FULL_NAME,
      train_name: r.TRAIN_NAME, train_number: r.TRAIN_NUMBER,
      source_station: r.SOURCE_STATION, destination_station: r.DESTINATION_STATION,
      journey_date: r.JOURNEY_DATE, travel_class: r.TRAVEL_CLASS,
    });
  } finally {
    await conn.close();
  }
});

// =========================================================
// POST /api/cancellations — cancel ticket (calls cancel_ticket proc)
// =========================================================
app.post('/api/cancellations', async (req, res) => {
  const conn = await getConn();
  try {
    await conn.execute(
      `BEGIN cancel_ticket(:1); END;`,
      [String(req.body.pnr || '').toUpperCase()]
    );
    res.json({ message: 'Ticket cancelled and seat availability updated.' });
  } catch (err) {
    if (err.errorNum === 20003)
      return res.status(400).json({ message: 'This ticket is already cancelled.' });
    if (err.errorNum === 20004)
      return res.status(404).json({ message: 'No ticket found for this PNR.' });
    res.status(500).json({ message: err.message });
  } finally {
    await conn.close();
  }
});

// =========================================================
// Start server
// =========================================================
initPool()
  .then(() => app.listen(3000, () =>
    console.log('RailReserve running at http://localhost:3000')))
  .catch(err => {
    console.error('Failed to connect to Oracle:', err.message);
    process.exit(1);
  });
