// api/support.js
import {
  supabaseAdmin,
  getAuthedUser,
  getBody
} from '../lib/supabase-admin.js';

function cleanText(value, maxLength = 2000) {
  return String(value || '')
    .trim()
    .slice(0, maxLength);
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    // =====================================
    // GET ENDPOINTS
    // =====================================
    if (req.method === 'GET') {
      const user = await getAuthedUser(req);
      if (!user) {
        return res.status(401).json({ error: 'Unauthenticated' });
      }

      const action = req.query.action || 'tickets';

      // -----------------------------------
      // LIST TICKETS
      // -----------------------------------
      if (action === 'tickets') {
        const { data: tickets, error } = await supabaseAdmin
          .from('support_tickets')
          .select('*')
          .eq('user_id', user.id)
          .order('updated_at', { ascending: false });

        if (error) throw error;

        return res.status(200).json({ success: true, tickets: tickets || [] });
      }

      // -----------------------------------
      // TICKET MESSAGES
      // -----------------------------------
      if (action === 'messages') {
        const ticketId = req.query.ticket_id;

        if (!ticketId) {
          return res.status(400).json({ error: 'Ticket ID is required' });
        }

        const { data: ticket, error: ticketError } = await supabaseAdmin
          .from('support_tickets')
          .select('*')
          .eq('id', ticketId)
          .eq('user_id', user.id)
          .maybeSingle();

        if (ticketError) throw ticketError;

        if (!ticket) {
          return res.status(404).json({ error: 'Ticket not found' });
        }

        const { data: messages, error: messagesError } = await supabaseAdmin
          .from('ticket_messages')
          .select('*')
          .eq('ticket_id', ticketId)
          .order('created_at', { ascending: true });

        if (messagesError) throw messagesError;

        return res.status(200).json({
          success: true,
          ticket,
          messages: messages || []
        });
      }

      return res.status(400).json({ error: 'Invalid action' });
    }

    // =====================================
    // POST ENDPOINTS
    // =====================================
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method not allowed' });
    }

    const user = await getAuthedUser(req);
    if (!user) {
      return res.status(401).json({ error: 'Unauthenticated' });
    }

    const body = getBody(req);
    const action = body.action;

    // -----------------------------------
    // CREATE TICKET
    // -----------------------------------
    if (action === 'create_ticket') {
      const subject = cleanText(body.subject, 120);
      const message = cleanText(body.message, 2000);

      if (!subject) {
        return res.status(400).json({ error: 'Subject is required' });
      }

      if (!message) {
        return res.status(400).json({ error: 'Message is required' });
      }

      const { data: ticket, error: ticketError } = await supabaseAdmin
        .from('support_tickets')
        .insert({
          user_id: user.id,
          subject,
          status: 'open',
          last_message: message,
          last_sender: 'user'
        })
        .select()
        .maybeSingle();

      if (ticketError) throw ticketError;

      const { error: messageError } = await supabaseAdmin
        .from('ticket_messages')
        .insert({
          ticket_id: ticket.id,
          sender_type: 'user',
          message
        });

      if (messageError) throw messageError;

      return res.status(200).json({
        success: true,
        message: 'Support ticket created',
        ticket
      });
    }

    // -----------------------------------
    // REPLY TO TICKET
    // -----------------------------------
    if (action === 'reply') {
      const ticketId = body.ticket_id;
      const message = cleanText(body.message, 2000);

      if (!ticketId) {
        return res.status(400).json({ error: 'Ticket ID is required' });
      }

      if (!message) {
        return res.status(400).json({ error: 'Message is required' });
      }

      const { data: ticket, error: ticketError } = await supabaseAdmin
        .from('support_tickets')
        .select('id, user_id, status')
        .eq('id', ticketId)
        .eq('user_id', user.id)
        .maybeSingle();

      if (ticketError) throw ticketError;

      if (!ticket) {
        return res.status(404).json({ error: 'Ticket not found' });
      }

      const { error: messageError } = await supabaseAdmin
        .from('ticket_messages')
        .insert({
          ticket_id: ticket.id,
          sender_type: 'user',
          message
        });

      if (messageError) throw messageError;

      const { error: updateError } = await supabaseAdmin
        .from('support_tickets')
        .update({
          status: ticket.status === 'closed' ? 'open' : ticket.status,
          last_message: message,
          last_sender: 'user',
          updated_at: new Date().toISOString()
        })
        .eq('id', ticket.id);

      if (updateError) throw updateError;

      return res.status(200).json({
        success: true,
        message: 'Reply sent'
      });
    }

    return res.status(400).json({ error: 'Invalid action' });
  } catch (err) {
    console.error('Support API error:', err);
    return res.status(500).json({ error: err.message || 'Server error' });
  }
}
