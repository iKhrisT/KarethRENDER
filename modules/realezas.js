const { getEconomy, saveEconomy, getRealezas, saveRealezas, getRealezaTaxes, saveRealezaTaxes } = require('./database');
const { getBalance, setBalance, getBankBalance, setBankBalance, formatNumber } = require('./economy');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');

// Realeza management functions
const TAXES_PAUSED = true;

function hasRealeza(userId) {
  const realezas = getRealezas();
  return realezas.hasOwnProperty(userId);
}

function getRealeza(userId) {
  const realezas = getRealezas();
  return realezas[userId];
}

function createRealeza(userId, name, color, initials) {
  const realezas = getRealezas();
  realezas[userId] = {
    name: name,
    color: color,
    initials: initials,
    money: 0,
    members: [userId],
    creationDate: Date.now(),
    rey: userId,
    taxRate: 20,
    memberNicknames: {},
    spouseMembers: []
  };
  saveRealezas();
  return realezas[userId];
}

// Add a king's spouse to the realeza automatically (marks them as a spouse-member)
async function addSpouseToRealeza(guild, kingId, spouseId) {
  const realezas = getRealezas();
  const realeza = realezas[kingId];
  if (!realeza) return;
  if (realeza.members.includes(spouseId)) return;

  realeza.members.push(spouseId);
  if (!realeza.spouseMembers) realeza.spouseMembers = [];
  if (!realeza.spouseMembers.includes(spouseId)) realeza.spouseMembers.push(spouseId);
  saveRealezas();

  try {
    if (!guild) return;
    const roleName = `👑 ${realeza.name}`;
    const role = guild.roles.cache.find(r => r.name === roleName);
    const member = await guild.members.fetch(spouseId);
    if (member && role) {
      await member.roles.add(role);
    }

    if (!realeza.memberNicknames) realeza.memberNicknames = {};
    const originalNick = await applyRealezaNickname(guild, spouseId, realeza.initials);
    if (originalNick !== undefined) {
      realeza.memberNicknames[spouseId] = originalNick;
      saveRealezas();
    }
  } catch (error) {
    console.error('Error añadiendo cónyuge a la realeza:', error);
  }
}

// Remove a king's spouse from the realeza (only if they were added automatically due to marriage)
async function removeSpouseFromRealeza(guild, kingId, spouseId) {
  const realezas = getRealezas();
  const realeza = realezas[kingId];
  if (!realeza) return;
  if (!realeza.spouseMembers || !realeza.spouseMembers.includes(spouseId)) return;

  const originalNick = realeza.memberNicknames?.[spouseId];
  realeza.members = realeza.members.filter(id => id !== spouseId);
  realeza.spouseMembers = realeza.spouseMembers.filter(id => id !== spouseId);
  if (realeza.memberNicknames) delete realeza.memberNicknames[spouseId];
  saveRealezas();

  try {
    if (!guild) return;
    const roleName = `👑 ${realeza.name}`;
    const role = guild.roles.cache.find(r => r.name === roleName);
    const member = guild.members.cache.get(spouseId);
    if (member && role) {
      await member.roles.remove(role);
    }
    await restoreNickname(guild, spouseId, originalNick);
  } catch (error) {
    console.error('Error removiendo cónyuge de la realeza:', error);
  }
}

// Called when a marriage happens: whichever party is a king, adds the other as a member
async function syncMarriageWithRealeza(guild, userId1, userId2) {
  if (hasRealeza(userId1)) {
    await addSpouseToRealeza(guild, userId1, userId2);
  }
  if (hasRealeza(userId2)) {
    await addSpouseToRealeza(guild, userId2, userId1);
  }
}

// Called when a divorce happens: removes the spouse from the king's realeza if auto-added
async function syncDivorceWithRealeza(guild, userId1, userId2) {
  if (hasRealeza(userId1)) {
    await removeSpouseFromRealeza(guild, userId1, userId2);
  }
  if (hasRealeza(userId2)) {
    await removeSpouseFromRealeza(guild, userId2, userId1);
  }
}

// Set realeza nickname for a member and save original
async function applyRealezaNickname(guild, userId, initials) {
  try {
    const member = await guild.members.fetch(userId);
    const originalNick = member.nickname;
    const displayName = member.nickname || member.user.username;
    const newNick = `[${initials}] ${displayName}`;
    await member.setNickname(newNick.slice(0, 32));
    return originalNick;
  } catch (error) {
    console.error(`Error aplicando nickname de realeza a ${userId}:`, error);
    return undefined;
  }
}

// Restore original nickname when leaving realeza
async function restoreNickname(guild, userId, originalNick) {
  try {
    const member = await guild.members.fetch(userId);
    await member.setNickname(originalNick || null);
  } catch (error) {
    console.error(`Error restaurando nickname de ${userId}:`, error);
  }
}

function addRealezaMoney(userId, amount) {
  const realezas = getRealezas();
  if (realezas[userId]) {
    realezas[userId].money += amount;
    saveRealezas();
  }
}

// Apply realeza earnings tax: deducts the realeza's configured taxRate from member earnings.
// bonusMultiplier: if > 1, the realeza receives taxAmount * bonusMultiplier without extra deduction from the player.
function applyRealezaTax(userId, earnings, bonusMultiplier = 1) {
  if (TAXES_PAUSED) return earnings;
  const realezas = getRealezas();

  let userRealezaId = null;
  let userRealeza = null;
  for (const [realezaId, realezaData] of Object.entries(realezas)) {
    if (realezaData.members && realezaData.members.includes(userId)) {
      userRealezaId = realezaId;
      userRealeza = realezaData;
      break;
    }
  }

  if (!userRealeza) return earnings;

  const rate = (userRealeza.taxRate ?? 20) / 100;
  const taxAmount = Math.floor(earnings * rate);
  if (taxAmount <= 0) return earnings;

  const realezaReceives = Math.floor(taxAmount * bonusMultiplier);
  realezas[userRealezaId].money = (realezas[userRealezaId].money || 0) + realezaReceives;
  saveRealezas();

  return earnings - taxAmount;
}

function getRealezaTaxRateForUser(userId) {
  const realezas = getRealezas();
  for (const [, realezaData] of Object.entries(realezas)) {
    if (realezaData.members && realezaData.members.includes(userId)) {
      return realezaData.taxRate ?? 20;
    }
  }
  return 0;
}

function setRealezaTaxRate(userId, rate) {
  const realezas = getRealezas();
  if (!realezas[userId]) return false;
  realezas[userId].taxRate = rate;
  saveRealezas();
  return true;
}

function removeRealezaMoney(userId, amount) {
  const realezas = getRealezas();
  if (realezas[userId]) {
    realezas[userId].money = Math.max(0, realezas[userId].money - amount);
    saveRealezas();
  }
}

// Tax management functions
function updateRealezaTaxes() {
  const realezas = getRealezas();
  const realezaTaxes = getRealezaTaxes();
  const now = Date.now();
  const oneWeek = 7 * 24 * 60 * 60 * 1000;

  if (TAXES_PAUSED) {
    // Avoid accumulating charges for paused weeks if taxes are re-enabled later.
    for (const realezaId of Object.keys(realezas)) {
      if (!realezaTaxes[realezaId]) {
        realezaTaxes[realezaId] = {
          totalDebt: 0,
          lastTaxDate: now,
          weeksSinceLastPayment: 0,
          creationDate: now
        };
      } else {
        realezaTaxes[realezaId].lastTaxDate = now;
      }
    }
    saveRealezaTaxes();
    console.log('👑 Impuestos de realeza pausados - no se actualizan deudas');
    return;
  }

  for (const [realezaId, realezaData] of Object.entries(realezas)) {
    if (!realezaTaxes[realezaId]) {
      realezaTaxes[realezaId] = {
        totalDebt: 0,
        lastTaxDate: now,
        weeksSinceLastPayment: 0,
        creationDate: now
      };
    }

    const taxData = realezaTaxes[realezaId];
    const timeSinceLastTax = now - taxData.lastTaxDate;

    if (timeSinceLastTax >= oneWeek) {
      const weeksPassed = Math.floor(timeSinceLastTax / oneWeek);

      for (let i = 0; i < weeksPassed; i++) {
        const weeklyTax = calculateWeeklyTax(realezaId);
        taxData.totalDebt += weeklyTax;
        taxData.weeksSinceLastPayment++;
      }

      taxData.lastTaxDate = now - (timeSinceLastTax % oneWeek);
    }
  }

  saveRealezaTaxes();
}

function calculateWeeklyTax(realezaId) {
  const realezas = getRealezas();
  const realeza = realezas[realezaId];

  if (!realeza) return 0;

  const ranked = Object.entries(realezas).sort(([, a], [, b]) => b.money - a.money);
  const rank = ranked.findIndex(([id]) => id === realezaId) + 1;

  if (rank === 1) return Math.floor(realeza.money * 0.35);
  if (rank === 2) return Math.floor(realeza.money * 0.27);
  if (rank <= 5) return Math.floor(realeza.money * 0.20);
  return 500000;
}

function payRealezaTax(userId, amount) {
  const realezaTaxes = getRealezaTaxes();

  if (!realezaTaxes[userId]) {
    realezaTaxes[userId] = {
      totalDebt: 0,
      lastTaxDate: Date.now(),
      weeksSinceLastPayment: 0,
      creationDate: Date.now()
    };
  }

  const taxData = realezaTaxes[userId];
  const actualPaid = Math.min(amount, taxData.totalDebt);

  taxData.totalDebt -= actualPaid;

  if (taxData.totalDebt === 0) {
    taxData.weeksSinceLastPayment = 0;
  }

  saveRealezaTaxes();
  return actualPaid;
}

function checkRealezaDissolution(client) {
  if (TAXES_PAUSED) return [];
  const realezas = getRealezas();
  const realezaTaxes = getRealezaTaxes();
  const dissolved = [];

  for (const [realezaId, taxData] of Object.entries(realezaTaxes)) {
    if (taxData.weeksSinceLastPayment >= 3 && realezas[realezaId] && !realezas[realezaId].bankrupt) {
      console.log(`Marking realeza ${realezas[realezaId].name} as bankrupt due to unpaid taxes`);
      realezas[realezaId].bankrupt = true;
      dissolved.push(realezaId);
    }
  }

  if (dissolved.length > 0) {
    saveRealezas();
  }

  return dissolved;
}

// Handle realeza command
async function handleRealezaCommand(interaction, client) {
  const userId = interaction.user.id;
  const action = interaction.options.getString('accion');
  const cantidad = interaction.options.getString('cantidad');
  const targetUser = interaction.options.getUser('usuario');
  const memberType = interaction.options.getString('tipo');

  if (action === 'info') {
    if (!hasRealeza(userId)) {
      return await interaction.reply({
        content: 'No tienes una realeza. Compra el item "Realeza Celestial" en la tienda y úsalo para crear una.',
        ephemeral: true
      });
    }

    const realeza = getRealeza(userId);
    const creationDate = new Date(realeza.creationDate).toLocaleDateString('es-ES');

    let membersText = '';
    for (const memberId of realeza.members) {
      try {
        const member = await client.users.fetch(memberId);
        membersText += `• ${member.username}${memberId === realeza.rey ? ' (Rey)' : ''}\n`;
      } catch (error) {
        membersText += `• Usuario desconocido${memberId === realeza.rey ? ' (Rey)' : ''}\n`;
      }
    }

    const embed = new EmbedBuilder()
      .setTitle(`👑 ${realeza.name}`)
      .setDescription(`Información completa de tu realeza celestial`)
      .addFields(
        { name: '👑 Nombre', value: `**${realeza.name}**`, inline: true },
        { name: '🎨 Color', value: realeza.color, inline: true },
        { name: '🔤 Iniciales', value: `**${realeza.initials}**`, inline: true },
        { name: '💰 Fondos', value: `${formatNumber(realeza.money)} Khronidas`, inline: true },
        { name: '👥 Miembros', value: `${realeza.members.length}`, inline: true },
        { name: '📅 Creación', value: creationDate, inline: true },
        { name: '👤 Miembros de la Realeza', value: membersText || 'Sin miembros', inline: false }
      )
      .setColor(realeza.color)
      .setFooter({ text: `Rey: ${interaction.user.username}` });

    await interaction.reply({ embeds: [embed] });
    return;
  }

  if (action === 'leaderboard') {
    const allRealezas = getRealezas();
    const realezasList = Object.entries(allRealezas)
      .sort(([,a], [,b]) => b.money - a.money)
      .slice(0, 10);

    if (realezasList.length === 0) {
      const embed = new EmbedBuilder()
        .setTitle('👑 Leaderboard de Realezas')
        .setDescription('No hay realezas registradas aún.')
        .setColor('#ff6b6b');

      return await interaction.reply({ embeds: [embed] });
    }

    let leaderboard = '';

    for (let i = 0; i < realezasList.length; i++) {
      const [ownerId, realezaData] = realezasList[i];
      try {
        const position = i + 1;
        const medal = position === 1 ? '🥇' : position === 2 ? '🥈' : position === 3 ? '🥉' : `${position}.`;
        const owner = await client.users.fetch(ownerId);

        leaderboard += `${medal} **${realezaData.name}** - ${formatNumber(realezaData.money)} Khronidas\n`;
        leaderboard += `   └ *Rey: ${owner.username}* | *Miembros: ${realezaData.members.length}*\n\n`;
      } catch (error) {
        const position = i + 1;
        const medal = position === 1 ? '🥇' : position === 2 ? '🥈' : position === 3 ? '🥉' : `${position}.`;

        leaderboard += `${medal} **${realezaData.name}** - ${formatNumber(realezaData.money)} Khronidas\n`;
        leaderboard += `   └ *Rey: Usuario desconocido* | *Miembros: ${realezaData.members.length}*\n\n`;
      }
    }

    const embed = new EmbedBuilder()
      .setTitle('👑 Leaderboard de Realezas')
      .setDescription(`**TOP ${realezasList.length} REALEZAS POR FONDOS**\n\n${leaderboard}`)
      .addFields(
        { name: '💰 Criterio', value: 'Ordenado por fondos totales', inline: true },
        { name: '📊 Total de realezas', value: `${Object.keys(allRealezas).length}`, inline: true }
      )
      .setColor('#ffd700')
      .setFooter({ text: 'Solo se muestran las top 10 realezas' });

    await interaction.reply({ embeds: [embed] });
    return;
  }

  if (action === 'dep') {
    if (!hasRealeza(userId)) {
      return await interaction.reply({
        content: 'No tienes una realeza. Compra el item "Realeza Celestial" en la tienda y úsalo para crear una.',
        ephemeral: true
      });
    }

    if (!cantidad) {
      return await interaction.reply({
        content: 'Debes especificar una cantidad para depositar.',
        ephemeral: true
      });
    }

    const realeza = getRealeza(userId);
    // FIX: usar getBalance() directamente en lugar de economy.getBalance()
    const currentMoney = getBalance(userId);
    let depositAmount;

    if (cantidad.toLowerCase() === 'all') {
      depositAmount = currentMoney;
    } else {
      depositAmount = parseInt(cantidad);
      if (isNaN(depositAmount) || depositAmount <= 0) {
        return await interaction.reply({
          content: 'Cantidad inválida. Usa un número positivo o "all".',
          ephemeral: true
        });
      }
    }

    if (currentMoney <= 0) {
      return await interaction.reply({
        content: 'No tienes dinero en mano para depositar.',
        ephemeral: true
      });
    }

    if (depositAmount > currentMoney) {
      return await interaction.reply({
        content: `No tienes suficiente dinero en mano. Tienes ${formatNumber(currentMoney)} Khronidas.`,
        ephemeral: true
      });
    }

    // FIX: usar setBalance() directamente en lugar de economy.setBalance()
    setBalance(userId, currentMoney - depositAmount);
    addRealezaMoney(userId, depositAmount);

    const updatedRealeza = getRealeza(userId);

    const embed = new EmbedBuilder()
      .setTitle('💰 Depósito Exitoso')
      .setDescription(`Has depositado **${formatNumber(depositAmount)} Khronidas** en ${realeza.name}`)
      .addFields(
        { name: '👑 Realeza', value: realeza.name, inline: true },
        { name: '💵 Cantidad Depositada', value: `${formatNumber(depositAmount)} Khronidas`, inline: true },
        { name: '🏦 Fondos de la Realeza', value: `${formatNumber(updatedRealeza.money)} Khronidas`, inline: true },
        // FIX: usar getBalance() directamente
        { name: '💰 Tu dinero restante', value: `${formatNumber(getBalance(userId))} Khronidas`, inline: true }
      )
      .setColor(realeza.color)
      .setFooter({ text: 'Los fondos han sido transferidos exitosamente' });

    await interaction.reply({ embeds: [embed] });
    return;
  }

  if (action === 'with') {
    if (!hasRealeza(userId)) {
      return await interaction.reply({
        content: 'No tienes una realeza. Compra el item "Realeza Celestial" en la tienda y úsalo para crear una.',
        ephemeral: true
      });
    }

    if (!cantidad) {
      return await interaction.reply({
        content: 'Debes especificar una cantidad para retirar.',
        ephemeral: true
      });
    }

    const realeza = getRealeza(userId);
    let withdrawAmount;

    if (cantidad.toLowerCase() === 'all') {
      withdrawAmount = realeza.money;
    } else {
      withdrawAmount = parseInt(cantidad);
      if (isNaN(withdrawAmount) || withdrawAmount <= 0) {
        return await interaction.reply({
          content: 'Cantidad inválida. Usa un número positivo o "all".',
          ephemeral: true
        });
      }
    }

    if (realeza.money <= 0) {
      return await interaction.reply({
        content: 'La realeza no tiene fondos para retirar.',
        ephemeral: true
      });
    }

    if (withdrawAmount > realeza.money) {
      return await interaction.reply({
        content: `La realeza no tiene suficientes fondos. Tiene ${formatNumber(realeza.money)} Khronidas.`,
        ephemeral: true
      });
    }

    // FIX: usar getBalance() y setBalance() directamente
    const currentMoney = getBalance(userId);
    removeRealezaMoney(userId, withdrawAmount);
    setBalance(userId, currentMoney + withdrawAmount);

    const updatedRealeza = getRealeza(userId);

    const embed = new EmbedBuilder()
      .setTitle('💸 Retiro Exitoso')
      .setDescription(`Has retirado **${formatNumber(withdrawAmount)} Khronidas** de ${realeza.name}`)
      .addFields(
        { name: '👑 Realeza', value: realeza.name, inline: true },
        { name: '💵 Cantidad Retirada', value: `${formatNumber(withdrawAmount)} Khronidas`, inline: true },
        { name: '🏦 Fondos restantes', value: `${formatNumber(updatedRealeza.money)} Khronidas`, inline: true },
        // FIX: usar getBalance() directamente
        { name: '💰 Tu dinero actual', value: `${formatNumber(getBalance(userId))} Khronidas`, inline: true }
      )
      .setColor(realeza.color)
      .setFooter({ text: 'Los fondos han sido transferidos exitosamente' });

    await interaction.reply({ embeds: [embed] });
    return;
  }

  if (action === 'miembro') {
    if (!hasRealeza(userId)) {
      return await interaction.reply({
        content: 'No tienes una realeza. Compra el item "Realeza Celestial" en la tienda y úsalo para crear una.',
        ephemeral: true
      });
    }

    if (!targetUser || !memberType) {
      return await interaction.reply({
        content: 'Debes especificar un usuario y el tipo de acción (añadir o remover).',
        ephemeral: true
      });
    }

    const realeza = getRealeza(userId);

    if (memberType === 'add') {
      if (realeza.members.includes(targetUser.id)) {
        return await interaction.reply({
          content: `${targetUser.username} ya es miembro de ${realeza.name}.`,
          ephemeral: true
        });
      }

      const inviteEmbed = new EmbedBuilder()
        .setTitle('👑 Invitación a Realeza')
        .setDescription(`**${interaction.user.username}** te ha invitado a unirte a la realeza **${realeza.name}**\n\n${targetUser}, acepta o rechaza la invitación usando los botones de abajo.`)
        .addFields(
          { name: '👑 Realeza', value: realeza.name, inline: true },
          { name: '🎨 Color', value: realeza.color, inline: true },
          { name: '👤 Rey', value: `<@${realeza.rey}>`, inline: true }
        )
        .setColor(realeza.color);

      const row = new ActionRowBuilder()
        .addComponents(
          new ButtonBuilder()
            .setCustomId(`accept_member_invitation_${userId}_${targetUser.id}`)
            .setLabel('Aceptar')
            .setStyle(ButtonStyle.Success),
          new ButtonBuilder()
            .setCustomId(`reject_member_invitation_${userId}_${targetUser.id}`)
            .setLabel('Rechazar')
            .setStyle(ButtonStyle.Danger)
        );

      await interaction.reply({
        embeds: [inviteEmbed],
        components: [row]
      });
      return;
    }

    if (memberType === 'remove') {
      if (!realeza.members.includes(targetUser.id)) {
        return await interaction.reply({
          content: `${targetUser.username} no es miembro de ${realeza.name}.`,
          ephemeral: true
        });
      }

      if (targetUser.id === realeza.rey) {
        return await interaction.reply({
          content: 'No puedes remover al Rey de la realeza.',
          ephemeral: true
        });
      }

      const realezas = getRealezas();
      const removedNick = realezas[userId].memberNicknames?.[targetUser.id];
      realezas[userId].members = realezas[userId].members.filter(id => id !== targetUser.id);
      if (realezas[userId].memberNicknames) delete realezas[userId].memberNicknames[targetUser.id];
      saveRealezas();

      try {
        const guild = interaction.guild;
        const member = guild.members.cache.get(targetUser.id);
        const roleName = `👑 ${realeza.name}`;
        const role = guild.roles.cache.find(r => r.name === roleName);
        if (member && role) {
          await member.roles.remove(role);
        }
        // Restore original nickname
        await restoreNickname(guild, targetUser.id, removedNick);
      } catch (error) {
        console.error('Error removiendo rol:', error);
      }

      const embed = new EmbedBuilder()
        .setTitle('👤 Miembro Removido')
        .setDescription(`${targetUser.username} ha sido removido de ${realeza.name}`)
        .setColor(realeza.color);

      await interaction.reply({ embeds: [embed] });
      return;
    }
  }

  if (action === 'taxes') {
    if (!hasRealeza(userId)) {
      return await interaction.reply({
        content: 'No tienes una realeza. Compra el item "Realeza Celestial" en la tienda y úsalo para crear una.',
        ephemeral: true
      });
    }

    const realeza = getRealeza(userId);
    const realezaTaxes = getRealezaTaxes();

    if (!realezaTaxes[userId]) {
      realezaTaxes[userId] = {
        totalDebt: 0,
        lastTaxDate: Date.now(),
        weeksSinceLastPayment: 0,
        creationDate: Date.now()
      };
      saveRealezaTaxes();
    }

    const taxData = realezaTaxes[userId];
    const weeklyTax = calculateWeeklyTax(userId);

    const allRealezas = getRealezas();
    const rankedRealezas = Object.entries(allRealezas).sort(([, a], [, b]) => b.money - a.money);
    const realezaRank = rankedRealezas.findIndex(([id]) => id === userId) + 1;
    const rankText = realezaRank === 1 ? '35%' : realezaRank === 2 ? '27%' : realezaRank <= 5 ? '20%' : '500,000 Kh fijo';

    const embed = new EmbedBuilder()
      .setTitle('💰 Sistema de Impuestos de Realeza')
      .setDescription(`Estado de impuestos para **${realeza.name}**`)
      .addFields(
        { name: '👑 Realeza', value: `**${realeza.name}**`, inline: true },
        { name: '🏆 Ranking', value: `#${realezaRank}`, inline: true },
        { name: '🏦 Fondos Actuales', value: `${formatNumber(realeza.money)} Khronidas`, inline: true },
        { name: '💸 Impuesto Semanal', value: TAXES_PAUSED ? '⏸️ Pausado' : `${formatNumber(weeklyTax)} Khronidas (${rankText})`, inline: true },
        { name: '💰 Deuda Total', value: `${formatNumber(taxData.totalDebt)} Khronidas`, inline: true },
        { name: '📅 Semanas sin Pagar', value: `${taxData.weeksSinceLastPayment}/3 semanas`, inline: true },
        { name: '⏰ Estado', value: TAXES_PAUSED ? '⏸️ Impuestos pausados; deuda congelada' : taxData.totalDebt === 0 ? '✅ Al día' : taxData.weeksSinceLastPayment >= 2 ? '🚨 CRÍTICO' : '⚠️ Con deuda', inline: true },
        { name: '💸 Impuesto de Ganancias', value: TAXES_PAUSED ? `⏸️ Pausado (porcentaje configurado: ${realeza.taxRate ?? 20}%)` : `${realeza.taxRate ?? 20}% de las ganancias de cada miembro`, inline: true },
        { name: '📊 Sistema de Impuestos', value: TAXES_PAUSED ? 'Los impuestos semanales y sobre ganancias están pausados. Las deudas existentes se conservan congeladas y no causan disolución durante la pausa.' : '• Top 1: 35% de fondos semanalmente\n• Top 2: 27% de fondos semanalmente\n• Top 3-5: 20% de fondos semanalmente\n• Top 6+: 500,000 Kh fijo semanalmente\n• Si no pagas en 3 semanas: disolución automática', inline: false }
      )
      .setColor(TAXES_PAUSED ? '#808080' : taxData.totalDebt === 0 ? '#00ff00' : taxData.weeksSinceLastPayment >= 2 ? '#ff0000' : '#ffaa00')
      .setFooter({ text: TAXES_PAUSED ? 'Impuestos de realeza pausados' : taxData.weeksSinceLastPayment >= 2 ? '¡REALEZA EN PELIGRO DE DISOLUCIÓN!' : 'Usa /realeza pay-taxes para pagar' });

    await interaction.reply({ embeds: [embed] });
    return;
  }

  if (action === 'pay-taxes') {
    if (!hasRealeza(userId)) {
      return await interaction.reply({
        content: 'No tienes una realeza. Compra el item "Realeza Celestial" en la tienda y úsalo para crear una.',
        ephemeral: true
      });
    }
    if (TAXES_PAUSED) {
      return await interaction.reply({
        content: '⏸️ Los impuestos de realeza están pausados. Las deudas existentes se conservan congeladas y no se procesan pagos durante la pausa.',
        ephemeral: true
      });
    }

    const realeza = getRealeza(userId);
    const realezaTaxes = getRealezaTaxes();

    if (!realezaTaxes[userId]) {
      realezaTaxes[userId] = {
        totalDebt: 0,
        lastTaxDate: Date.now(),
        weeksSinceLastPayment: 0,
        creationDate: Date.now()
      };
      saveRealezaTaxes();
    }

    const taxData = realezaTaxes[userId];

    if (taxData.totalDebt === 0) {
      return await interaction.reply({
        content: 'Tu realeza no tiene deudas de impuestos pendientes.',
        ephemeral: true
      });
    }

    if (!cantidad) {
      return await interaction.reply({
        content: `Debes especificar cuánto quieres pagar. Deuda total: ${formatNumber(taxData.totalDebt)} Khronidas\nUsa un número específico o "all" para pagar toda la deuda.`,
        ephemeral: true
      });
    }

    let payAmount;
    if (cantidad.toLowerCase() === 'all') {
      payAmount = taxData.totalDebt;
    } else {
      payAmount = parseInt(cantidad);
      if (isNaN(payAmount) || payAmount <= 0) {
        return await interaction.reply({
          content: 'Cantidad inválida. Usa un número positivo o "all".',
          ephemeral: true
        });
      }
    }

    if (payAmount > realeza.money) {
      return await interaction.reply({
        content: `Tu realeza no tiene suficientes fondos. Tiene ${formatNumber(realeza.money)} Khronidas y la deuda es ${formatNumber(taxData.totalDebt)} Khronidas.`,
        ephemeral: true
      });
    }

    const actualPaid = payRealezaTax(userId, payAmount);
    removeRealezaMoney(userId, actualPaid);

    const updatedRealeza = getRealeza(userId);
    const updatedTaxData = realezaTaxes[userId];

    const embed = new EmbedBuilder()
      .setTitle('💰 Impuestos de Realeza Pagados')
      .setDescription(`**${realeza.name}** ha pagado impuestos por ${formatNumber(actualPaid)} Khronidas`)
      .addFields(
        { name: '💸 Cantidad Pagada', value: `${formatNumber(actualPaid)} Khronidas`, inline: true },
        { name: '💰 Deuda Restante', value: `${formatNumber(updatedTaxData.totalDebt)} Khronidas`, inline: true },
        { name: '🏦 Fondos Restantes', value: `${formatNumber(updatedRealeza.money)} Khronidas`, inline: true },
        { name: '📅 Estado', value: updatedTaxData.totalDebt === 0 ? '✅ Completamente al día' : `⚠️ ${updatedTaxData.weeksSinceLastPayment} semanas sin pago completo`, inline: true }
      )
      .setColor(updatedTaxData.totalDebt === 0 ? '#00ff00' : '#ffaa00')
      .setFooter({ text: updatedTaxData.totalDebt === 0 ? '¡Realeza libre de deudas fiscales!' : 'Continúa pagando para evitar la disolución' });

    await interaction.reply({ embeds: [embed] });
    return;
  }

  if (action === 'set-tax-rate') {
    if (!hasRealeza(userId)) {
      return await interaction.reply({
        content: 'No tienes una realeza.',
        ephemeral: true
      });
    }

    const realeza = getRealeza(userId);

    if (realeza.rey !== userId) {
      return await interaction.reply({
        content: '❌ Solo el **Rey** de la realeza puede cambiar el porcentaje de impuesto de ganancias.',
        ephemeral: true
      });
    }

    const porcentaje = interaction.options.getNumber('porcentaje');
    if (porcentaje === null || porcentaje === undefined) {
      return await interaction.reply({
        content: `📊 El impuesto de ganancias actual de **${realeza.name}** es del **${realeza.taxRate ?? 20}%**.\n\nUsa \`/realeza set-tax-rate\` con el parámetro \`porcentaje\` para cambiarlo (0-100).`,
        ephemeral: true
      });
    }

    setRealezaTaxRate(userId, porcentaje);

    const embed = new EmbedBuilder()
      .setTitle('💰 Impuesto de Ganancias Actualizado')
      .setDescription(`El impuesto de ganancias de **${realeza.name}** ha sido actualizado.`)
      .addFields(
        { name: '📊 Nuevo Porcentaje', value: `**${porcentaje}%**`, inline: true },
        { name: '⚡ Efecto', value: 'Se descontará automáticamente de los ingresos de todos los miembros de la realeza (/work, /crime, /daily, /invert)', inline: false }
      )
      .setColor(realeza.color)
      .setFooter({ text: `Establecido por el Rey de ${realeza.name}` });

    await interaction.reply({ embeds: [embed] });
    return;
  }
}

// Handle realeza creation
async function handleRealezaCreation(interaction, userId, itemIndex, purchaseDate, realezaName, realezaColor, realezaInitials, client) {
  const { EmbedBuilder } = require('discord.js');
  const store = require('./store');

  if (!realezaColor.match(/^#[0-9A-Fa-f]{6}$/)) {
    return await interaction.reply({
      content: 'Color inválido. Debe ser un código hexadecimal (ej: #ff0000)',
      ephemeral: true
    });
  }

  if (realezaInitials.length < 2 || realezaInitials.length > 3) {
    return await interaction.reply({
      content: 'Las iniciales deben tener 2 o 3 letras',
      ephemeral: true
    });
  }

  if (hasRealeza(userId)) {
    return await interaction.reply({
      content: 'Ya tienes una realeza. No puedes crear otra.',
      ephemeral: true
    });
  }

  try {
    const guild = interaction.guild;

    const roleName = `👑 ${realezaName}`;
    const realezaRole = await guild.roles.create({
      name: roleName,
      color: realezaColor,
      reason: `Realeza creada por ${interaction.user.username}`,
      permissions: []
    });

    const member = guild.members.cache.get(userId);
    if (member) {
      await member.roles.add(realezaRole);
    }

    createRealeza(userId, realezaName, realezaColor, realezaInitials.toUpperCase());

    // Apply realeza nickname to the king
    const realezas = getRealezas();
    if (!realezas[userId].memberNicknames) realezas[userId].memberNicknames = {};
    const originalNick = await applyRealezaNickname(guild, userId, realezaInitials.toUpperCase());
    if (originalNick !== undefined) {
      realezas[userId].memberNicknames[userId] = originalNick;
      saveRealezas();
    }

    // If the king is already married, auto-add their spouse as a member
    try {
      const marriages = require('./marriages');
      const marriageStatus = marriages.isMarried(userId);
      if (marriageStatus.married) {
        const spouseId = marriageStatus.marriageData.proposer === userId
          ? marriageStatus.marriageData.partner
          : marriageStatus.marriageData.proposer;
        await addSpouseToRealeza(guild, userId, spouseId);
      }
    } catch (error) {
      console.error('Error sincronizando cónyuge al crear la realeza:', error);
    }

    store.removeSpecificFromInventory(userId, itemIndex, purchaseDate);

    const embed = new EmbedBuilder()
      .setTitle('👑 Realeza Creada Exitosamente')
      .setDescription(`**${realezaName}** ha sido fundada y está lista para gobernar.`)
      .addFields(
        { name: '👑 Nombre', value: `**${realezaName}**`, inline: true },
        { name: '🎨 Color', value: realezaColor, inline: true },
        { name: '🔤 Iniciales', value: `**${realezaInitials.toUpperCase()}**`, inline: true },
        { name: '👤 Rey', value: `${interaction.user}`, inline: true },
        { name: '🏷️ Rol Asignado', value: `@${roleName}`, inline: true },
        { name: '💰 Fondos Iniciales', value: '0 Khronidas', inline: true },
        { name: '💡 Próximos Pasos', value: '• Deposita fondos con `/realeza dep`\n• Añade miembros con `/realeza miembro`\n• Consulta información con `/realeza info`', inline: false }
      )
      .setColor(realezaColor)
      .setFooter({ text: 'Tu realeza ha sido creada exitosamente' });

    await interaction.reply({ embeds: [embed] });
  } catch (error) {
    console.error('Error creando realeza:', error);
    await interaction.reply({
      content: 'Hubo un error al crear tu realeza. Por favor intenta de nuevo.',
      ephemeral: true
    });
  }
}

// Handle member invitation response
async function handleMemberInvitationResponse(interaction, client) {
  const { EmbedBuilder } = require('discord.js');
  const [, , , realezaOwnerId, targetUserId] = interaction.customId.split('_');
  const userId = interaction.user.id;

  if (userId !== targetUserId) {
    return await interaction.reply({
      content: 'Esta invitación no es para ti.',
      ephemeral: true
    });
  }

  const realeza = getRealeza(realezaOwnerId);
  if (!realeza) {
    return await interaction.update({
      content: 'Esta realeza ya no existe.',
      components: []
    });
  }

  if (interaction.customId.startsWith('accept_member_invitation')) {
    const realezas = getRealezas();
    if (!realezas[realezaOwnerId].members.includes(userId)) {
      realezas[realezaOwnerId].members.push(userId);
      saveRealezas();
    }

    try {
      const guild = interaction.guild || client.guilds.cache.first();
      const member = guild.members.cache.get(userId);
      const roleName = `👑 ${realeza.name}`;
      const role = guild.roles.cache.find(r => r.name === roleName);
      if (member && role) {
        await member.roles.add(role);
      }

      // Apply realeza nickname
      if (!realezas[realezaOwnerId].memberNicknames) realezas[realezaOwnerId].memberNicknames = {};
      const originalNick = await applyRealezaNickname(guild, userId, realeza.initials);
      if (originalNick !== undefined) {
        realezas[realezaOwnerId].memberNicknames[userId] = originalNick;
        saveRealezas();
      }
    } catch (error) {
      console.error('Error añadiendo rol:', error);
    }

    const embed = new EmbedBuilder()
      .setTitle('✅ Invitación Aceptada')
      .setDescription(`Te has unido a la realeza **${realeza.name}**`)
      .addFields(
        { name: '👑 Realeza', value: realeza.name, inline: true },
        { name: '👤 Rey', value: `<@${realeza.rey}>`, inline: true },
        { name: '🎨 Color', value: realeza.color, inline: true }
      )
      .setColor(realeza.color);

    await interaction.update({ embeds: [embed], components: [] });

    try {
      const owner = await client.users.fetch(realezaOwnerId);
      await owner.send(`${interaction.user.username} ha aceptado unirse a ${realeza.name}`);
    } catch (error) {
      console.error('Error notificando al dueño:', error);
    }
  } else if (interaction.customId.startsWith('reject_member_invitation')) {
    const embed = new EmbedBuilder()
      .setTitle('❌ Invitación Rechazada')
      .setDescription(`Has rechazado la invitación a **${realeza.name}**`)
      .setColor('#ff0000');

    await interaction.update({ embeds: [embed], components: [] });

    try {
      const owner = await client.users.fetch(realezaOwnerId);
      await owner.send(`${interaction.user.username} ha rechazado la invitación a ${realeza.name}`);
    } catch (error) {
      console.error('Error notificando al dueño:', error);
    }
  }
}

// Handle withdrawal approval
async function handleWithdrawalApproval(interaction, client) {
  await interaction.reply({ content: 'Sistema de aprobación de retiros en desarrollo', ephemeral: true });
}

module.exports = {
  hasRealeza,
  getRealeza,
  createRealeza,
  addRealezaMoney,
  removeRealezaMoney,
  updateRealezaTaxes,
  calculateWeeklyTax,
  payRealezaTax,
  checkRealezaDissolution,
  handleRealezaCommand,
  handleRealezaCreation,
  handleMemberInvitationResponse,
  handleWithdrawalApproval,
  applyRealezaTax,
  getRealezaTaxRateForUser,
  setRealezaTaxRate,
  addSpouseToRealeza,
  removeSpouseFromRealeza,
  syncMarriageWithRealeza,
  syncDivorceWithRealeza
};