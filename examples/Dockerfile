FROM nodered/node-red:latest

# Install node-red-cluster storage module
RUN npm install node-red-cluster

# Expose Node-RED port
EXPOSE 1880

# Use default Node-RED entrypoint
CMD ["node-red"]
