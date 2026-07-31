const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const DATA_FILE = path.join(__dirname, 'reservation-data.json');
let nextPassengerId = 1001;
let nextTicketId = 1;
const passengers = [];
const users = [];
const services = [
  { service_id: 1, train_number: '12001', train_name: 'Shatabdi Express', source_station: 'New Delhi', destination_station: 'Bhopal', journey_date: '2026-08-02', departure_time: '06:00', arrival_time: '14:30', distance_km: 708, classes: { CC: { total: 3, available: 3, rate: 1.8 }, '2A': { total: 2, available: 2, rate: 2.4 } } },
  { service_id: 2, train_number: '12951', train_name: 'Mumbai Rajdhani', source_station: 'Mumbai Central', destination_station: 'New Delhi', journey_date: '2026-08-03', departure_time: '17:00', arrival_time: '08:35', distance_km: 1384, classes: { '3A': { total: 2, available: 2, rate: 1.45 }, '2A': { total: 2, available: 2, rate: 2.15 }, '1A': { total: 1, available: 1, rate: 3.4 } } },
  { service_id: 3, train_number: '12627', train_name: 'Karnataka Express', source_station: 'Bengaluru', destination_station: 'New Delhi', journey_date: '2026-08-04', departure_time: '19:20', arrival_time: '10:20', distance_km: 2367, classes: { SL: { total: 4, available: 4, rate: 0.65 }, '3A': { total: 3, available: 3, rate: 1.35 } } }
];
const tickets = [];

// A small file-backed store keeps this Node demo usable without an Oracle
// installation. In production, replace these reads/writes with calls to the
// PL/SQL procedures in database.sql.
function restoreData() {
  if (!fs.existsSync(DATA_FILE)) return;
  try {
    const saved = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    nextPassengerId = saved.nextPassengerId || nextPassengerId;
    nextTicketId = saved.nextTicketId || nextTicketId;
    passengers.push(...(saved.passengers || []));
    tickets.push(...(saved.tickets || []));
    users.push(...(saved.users || []));
    if (Array.isArray(saved.services)) {
      services.splice(0, services.length, ...saved.services);
    }
  } catch (error) {
    console.warn('Could not restore reservation data; starting with sample schedules.', error.message);
  }
}
function persistData() {
  fs.writeFileSync(DATA_FILE, JSON.stringify({ nextPassengerId, nextTicketId, passengers, users, services, tickets }, null, 2));
}
restoreData();

const serviceFor = id => services.find(s => s.service_id === Number(id));
const fareFor = (service, travelClass) => Math.round(((service.distance_km * service.classes[travelClass].rate + 25) * 1.05) * 100) / 100;
const publicService = service => ({ ...service, classes: Object.entries(service.classes).map(([travel_class, value]) => ({ travel_class, total_seats: value.total, available_seats: value.available })) });

const hashPassword = password => crypto.createHash('sha256').update(password).digest('hex');
app.post('/api/signup', (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) return res.status(400).json({ message: 'Name, email, and password are required.' });
  if (password.length < 6) return res.status(400).json({ message: 'Password must contain at least 6 characters.' });
  const normalizedEmail = email.trim().toLowerCase();
  if (users.some(user => user.email === normalizedEmail)) return res.status(409).json({ message: 'This email is already registered.' });
  users.push({ name: name.trim(), email: normalizedEmail, password_hash: hashPassword(password) });
  persistData();
  res.status(201).json({ message: 'Account created. You can now log in.' });
});
app.post('/api/signin', (req, res) => {
  const { email, password } = req.body;
  const user = users.find(item => item.email === String(email || '').trim().toLowerCase() && item.password_hash === hashPassword(String(password || '')));
  if (!user) return res.status(401).json({ message: 'Invalid email or password.' });
  res.json({ name: user.name, email: user.email });
});

app.get('/api/services', (req, res) => res.json(services.map(publicService)));

app.post('/api/passengers', (req, res) => {
  const { full_name, phone, email, id_type, id_number, date_of_birth, gender } = req.body;
  if (![full_name, phone, id_type, id_number].every(Boolean)) return res.status(400).json({ message: 'Name, phone and identification details are required.' });
  if (passengers.some(p => p.phone === phone || p.id_number === id_number)) return res.status(409).json({ message: 'A passenger with this phone or ID already exists.' });
  const passenger = { passenger_id: nextPassengerId++, full_name, phone, email: email || '', id_type, id_number, date_of_birth: date_of_birth || '', gender: gender || '' };
  passengers.push(passenger);
  persistData();
  res.status(201).json({ message: 'Passenger registered successfully.', passengerId: passenger.passenger_id });
});

app.get('/api/fare', (req, res) => {
  const service = serviceFor(req.query.service_id);
  const travelClass = String(req.query.travel_class || '').toUpperCase();
  if (!service || !service.classes[travelClass]) return res.status(400).json({ message: 'Choose a valid train service and class.' });
  res.json({ fare: fareFor(service, travelClass), distance_km: service.distance_km });
});

app.post('/api/bookings', (req, res) => {
  const passenger = passengers.find(p => p.passenger_id === Number(req.body.passenger_id));
  const service = serviceFor(req.body.service_id);
  const travelClass = String(req.body.travel_class || '').toUpperCase();
  if (!passenger) return res.status(404).json({ message: 'Passenger ID was not found. Register the passenger first.' });
  if (!service || !service.classes[travelClass]) return res.status(400).json({ message: 'Choose a valid train service and class.' });
  const inventory = service.classes[travelClass];
  const confirmed = inventory.available > 0;
  const waitlistNumber = tickets.filter(t => t.service_id === service.service_id && t.travel_class === travelClass && t.booking_status === 'WAITLIST').length + 1;
  const ticket = { ticket_id: nextTicketId++, pnr: `PNR${String(Date.now()).slice(-7)}${nextTicketId}`, passenger_id: passenger.passenger_id, service_id: service.service_id, travel_class: travelClass, booking_status: confirmed ? 'CONFIRMED' : 'WAITLIST', seat_number: confirmed ? `${travelClass}-${inventory.available}` : null, waitlist_number: confirmed ? null : waitlistNumber, fare: fareFor(service, travelClass), booked_at: new Date().toISOString() };
  if (confirmed) inventory.available--;
  tickets.push(ticket);
  persistData();
  res.status(201).json({ pnr: ticket.pnr, booking_status: ticket.booking_status, fare: ticket.fare, seat_number: ticket.seat_number, waitlist_number: ticket.waitlist_number });
});

const ticketDetails = ticket => {
  const passenger = passengers.find(p => p.passenger_id === ticket.passenger_id);
  const service = serviceFor(ticket.service_id);
  return { ...ticket, full_name: passenger.full_name, train_name: service.train_name, train_number: service.train_number, source_station: service.source_station, destination_station: service.destination_station, journey_date: service.journey_date };
};
app.get('/api/tickets/:pnr', (req, res) => {
  const ticket = tickets.find(t => t.pnr === req.params.pnr.toUpperCase());
  if (!ticket) return res.status(404).json({ message: 'No ticket found for this PNR.' });
  res.json(ticketDetails(ticket));
});

app.post('/api/cancellations', (req, res) => {
  const ticket = tickets.find(t => t.pnr === String(req.body.pnr || '').toUpperCase());
  if (!ticket) return res.status(404).json({ message: 'No ticket found for this PNR.' });
  if (ticket.booking_status === 'CANCELLED') return res.status(400).json({ message: 'This ticket is already cancelled.' });
  const wasConfirmed = ticket.booking_status === 'CONFIRMED';
  const inventory = serviceFor(ticket.service_id).classes[ticket.travel_class];
  ticket.booking_status = 'CANCELLED'; ticket.cancelled_at = new Date().toISOString(); ticket.seat_number = null; ticket.waitlist_number = null;
  let promoted = null;
  if (wasConfirmed) {
    inventory.available++;
    promoted = tickets.filter(t => t.service_id === ticket.service_id && t.travel_class === ticket.travel_class && t.booking_status === 'WAITLIST').sort((a, b) => a.waitlist_number - b.waitlist_number)[0];
    if (promoted) { promoted.booking_status = 'CONFIRMED'; promoted.seat_number = `${ticket.travel_class}-${inventory.available}`; promoted.waitlist_number = null; inventory.available--; }
  }
  persistData();
  res.json({ message: promoted ? `Ticket cancelled. Waitlist passenger ${promoted.pnr} was promoted to CONFIRMED.` : 'Ticket cancelled and seat availability updated.' });
});

app.listen(3000, () => console.log('Train reservation system: http://localhost:3000'));
